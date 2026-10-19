// A Supabase-client stand-in backed by a real PostgreSQL database (the local
// cluster from scripts/db/local-test.sh, with every migration applied). It
// translates the subset of the PostgREST query builder our server code uses
// into SQL, runs each request in its own transaction as the role PostgREST
// would use (service_role for the admin client; authenticated with JWT claims
// for a user), and returns PostgREST-shaped results ({ data, error, count },
// SQLSTATE error codes, ISO timestamps).
//
// So constraints, triggers, RLS, grants and the SQL functions all run for
// real. What it is not: PostgREST itself (no HTTP, no embedded resources, no
// schema cache) — a pass here is evidence about our SQL and server code
// together, not about the hosted platform.

import pg from 'pg'

type Row = Record<string, unknown>
type Result = { data: unknown; error: PgError | null; count?: number | null }
export interface PgError {
  code: string
  message: string
  details?: string | null
  hint?: string | null
}

export type Actor = { role: 'service_role' } | { role: 'authenticated'; userId: string } | { role: 'anon' }

// PostgREST returns timestamps as ISO strings and bigints as numbers.
const toIso = (value: string) => value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')
pg.types.setTypeParser(1184, toIso) // timestamptz
pg.types.setTypeParser(1114, (value) => value.replace(' ', 'T')) // timestamp
pg.types.setTypeParser(1082, (value) => value) // date
pg.types.setTypeParser(20, (value) => Number(value)) // int8
pg.types.setTypeParser(1700, (value) => Number(value)) // numeric

interface ColumnInfo {
  type: string
  isArray: boolean
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsupported identifier: ${name}`)
  return `"${name}"`
}

/** Column expression, including JSON paths such as error->>class. */
function columnExpr(column: string): string {
  const match = /^([a-z_][a-z0-9_]*)((?:->>?[a-z_][a-z0-9_]*)*)$/.exec(column)
  if (!match) throw new Error(`unsupported column: ${column}`)
  const path = (match[2] ?? '').replace(/(->>?)([a-z_][a-z0-9_]*)/g, (_, arrow: string, key: string) => `${arrow}'${key}'`)
  return `${ident(match[1]!)}${path}`
}

export class PgSupabase {
  private columns = new Map<string, Map<string, ColumnInfo>>()
  private keys = new Map<string, string[]>()
  private functions = new Map<string, { returnsSet: boolean; composite: boolean }>()

  constructor(
    readonly pool: pg.Pool,
    readonly actor: Actor = { role: 'service_role' },
  ) {}

  /** Another client on the same database, acting as someone else. */
  as(actor: Actor): PgSupabase {
    const client = new PgSupabase(this.pool, actor)
    client.columns = this.columns
    client.keys = this.keys
    client.functions = this.functions
    return client
  }

  from(table: string) {
    return new PgQuery(this, table)
  }

  rpc(name: string, args: Record<string, unknown> = {}): PromiseLike<Result> {
    return { then: (resolve, reject) => this.runRpc(name, args).then(resolve, reject) }
  }

  private async runRpc(name: string, args: Record<string, unknown>): Promise<Result> {
    const fn = await this.functionInfo(name)
    const params: unknown[] = []
    const named = Object.entries(args).map(([key, value]) => {
      params.push(value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value)
      return `${ident(key)} => $${params.length}`
    })
    const call = `public.${ident(name)}(${named.join(', ')})`
    const sql = fn.returnsSet || fn.composite ? `select * from ${call}` : `select ${call} as value`
    const result = await this.execute(sql, params)
    if (result.error) return { data: null, error: result.error }
    const rows = result.rows ?? []
    if (fn.returnsSet) return { data: rows, error: null }
    if (fn.composite) return { data: rows[0] ?? null, error: null }
    return { data: rows[0]?.value ?? null, error: null }
  }

  /** Runs SQL as this client's role, in its own transaction. */
  async execute(sql: string, params: unknown[] = []): Promise<{ rows?: Row[]; error: PgError | null }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query(`set local role ${this.actor.role}`)
      const claims = this.actor.role === 'authenticated' ? { sub: this.actor.userId, role: 'authenticated' } : { role: this.actor.role }
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
      const result = await client.query(sql, params)
      await client.query('commit')
      return { rows: result.rows as Row[], error: null }
    } catch (failure) {
      await client.query('rollback').catch(() => {})
      const error = failure as { code?: string; message?: string; detail?: string; hint?: string }
      return { error: { code: error.code ?? 'unknown', message: error.message ?? 'query failed', details: error.detail ?? null, hint: error.hint ?? null } }
    } finally {
      client.release()
    }
  }

  async columnInfo(table: string): Promise<Map<string, ColumnInfo>> {
    let info = this.columns.get(table)
    if (!info) {
      const { rows } = await this.pool.query(
        `select column_name, data_type, udt_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [table],
      )
      if (!rows.length) throw new Error(`unknown table: ${table}`)
      info = new Map(rows.map((row) => [row.column_name as string, { type: row.udt_name as string, isArray: row.data_type === 'ARRAY' }]))
      this.columns.set(table, info)
    }
    return info
  }

  async primaryKey(table: string): Promise<string[]> {
    let key = this.keys.get(table)
    if (!key) {
      const { rows } = await this.pool.query(
        `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = ('public.' || $1)::regclass and i.indisprimary`,
        [table],
      )
      key = rows.map((row) => row.attname as string)
      this.keys.set(table, key)
    }
    return key
  }

  private async functionInfo(name: string) {
    let info = this.functions.get(name)
    if (!info) {
      const { rows } = await this.pool.query(
        `select p.proretset, t.typtype from pg_proc p join pg_type t on t.oid = p.prorettype
         where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
        [name],
      )
      if (!rows[0]) throw new Error(`unknown function: ${name}`)
      info = { returnsSet: rows[0].proretset as boolean, composite: rows[0].typtype === 'c' }
      this.functions.set(name, info)
    }
    return info
  }
}

type Filter = { sql: (next: (value: unknown) => string) => string }

class PgQuery implements PromiseLike<Result> {
  private operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select'
  private columns = '*'
  private returning: string | null = null
  private count: 'exact' | null = null
  private head = false
  private filters: Filter[] = []
  private orders: string[] = []
  private limitCount: number | null = null
  private offsetCount: number | null = null
  private singleMode: false | 'maybe' | 'one' = false
  private values: Row[] = []
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {}

  constructor(
    private readonly client: PgSupabase,
    private readonly table: string,
  ) {}

  select(columns = '*', options: { count?: 'exact'; head?: boolean } = {}) {
    if (this.operation === 'select') {
      this.columns = columns
      this.count = options.count ?? null
      this.head = Boolean(options.head)
    } else {
      this.returning = columns
    }
    return this
  }
  insert(values: Row | Row[]) {
    this.operation = 'insert'
    this.values = Array.isArray(values) ? values : [values]
    return this
  }
  upsert(values: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.operation = 'upsert'
    this.values = Array.isArray(values) ? values : [values]
    this.upsertOptions = options
    return this
  }
  update(values: Row) {
    this.operation = 'update'
    this.values = [values]
    return this
  }
  delete() {
    this.operation = 'delete'
    return this
  }

  private compare(column: string, op: string, value: unknown) {
    this.filters.push({ sql: (next) => `${columnExpr(column)} ${op} ${next(value)}` })
    return this
  }
  eq(column: string, value: unknown) {
    return this.compare(column, '=', value)
  }
  neq(column: string, value: unknown) {
    return this.compare(column, '<>', value)
  }
  gt(column: string, value: unknown) {
    return this.compare(column, '>', value)
  }
  gte(column: string, value: unknown) {
    return this.compare(column, '>=', value)
  }
  lt(column: string, value: unknown) {
    return this.compare(column, '<', value)
  }
  lte(column: string, value: unknown) {
    return this.compare(column, '<=', value)
  }
  ilike(column: string, pattern: string) {
    return this.compare(column, 'ilike', pattern)
  }
  in(column: string, values: unknown[]) {
    this.filters.push({ sql: (next) => `${columnExpr(column)} = any(${next(values)})` })
    return this
  }
  is(column: string, value: null | boolean) {
    this.filters.push({ sql: () => `${columnExpr(column)} is ${value === null ? 'null' : value ? 'true' : 'false'}` })
    return this
  }
  not(column: string, operator: string, value: unknown) {
    if (operator === 'is') {
      this.filters.push({ sql: () => `${columnExpr(column)} is not ${value === null ? 'null' : value ? 'true' : 'false'}` })
      return this
    }
    if (operator === 'in') {
      const list = String(value).replace(/^\(|\)$/g, '').split(',').map((item) => item.trim())
      this.filters.push({ sql: (next) => `not (${columnExpr(column)} = any(${next(list)}))` })
      return this
    }
    this.filters.push({ sql: (next) => `not (${columnExpr(column)} ${OPERATORS[operator]!} ${next(value)})` })
    return this
  }
  /** PostgREST logic trees: "a.eq.1,and(b.is.null,c.lt.2)". */
  or(expression: string) {
    const tree = parseLogic(expression)
    this.filters.push({ sql: (next) => renderLogic({ kind: 'or', items: tree }, next) })
    return this
  }
  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const direction = options.ascending === false ? 'desc' : 'asc'
    const nulls = options.nullsFirst === undefined ? '' : options.nullsFirst ? ' nulls first' : ' nulls last'
    this.orders.push(`${columnExpr(column)} ${direction}${nulls}`)
    return this
  }
  limit(count: number) {
    this.limitCount = count
    return this
  }
  range(from: number, to: number) {
    this.offsetCount = from
    this.limitCount = to - from + 1
    return this
  }
  maybeSingle() {
    this.singleMode = 'maybe'
    return this
  }
  single() {
    this.singleMode = 'one'
    return this
  }

  then<A = Result, B = never>(resolve?: ((value: Result) => A | PromiseLike<A>) | null, reject?: ((reason: unknown) => B | PromiseLike<B>) | null) {
    return this.run().then(resolve, reject)
  }

  private selectList(columns: string): string {
    const list = columns
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean)
    if (list.length === 1 && list[0] === '*') return '*'
    return list.map((column) => (column.includes('(') ? unsupported(column) : ident(column))).join(', ')
  }

  private async run(): Promise<Result> {
    const params: unknown[] = []
    const info = await this.client.columnInfo(this.table)
    const next = (value: unknown) => {
      params.push(value instanceof Date ? value.toISOString() : value)
      return `$${params.length}`
    }
    const where = this.filters.length ? ` where ${this.filters.map((filter) => `(${filter.sql(next)})`).join(' and ')}` : ''
    const table = `public.${ident(this.table)}`

    const valueSql = (column: string, value: unknown) => {
      if (value === undefined) return 'default'
      const type = info.get(column)
      if (!type) throw new Error(`unknown column ${this.table}.${column}`)
      if (type.type === 'jsonb' || type.type === 'json') return `${next(value === null ? null : JSON.stringify(value))}::${type.type}`
      return next(value)
    }

    let sql: string
    if (this.operation === 'select') {
      sql = `select ${this.selectList(this.columns)} from ${table}${where}`
      if (this.orders.length) sql += ` order by ${this.orders.join(', ')}`
      if (this.limitCount !== null) sql += ` limit ${Math.max(0, this.limitCount)}`
      if (this.offsetCount !== null) sql += ` offset ${this.offsetCount}`
    } else if (this.operation === 'update') {
      const values = this.values[0]!
      const sets = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([column, value]) => `${ident(column)} = ${valueSql(column, value)}`)
      sql = `update ${table} set ${sets.join(', ')}${where}`
    } else if (this.operation === 'delete') {
      sql = `delete from ${table}${where}`
    } else {
      if (!this.values.length) return { data: [], error: null }
      const columns = [...new Set(this.values.flatMap((row) => Object.keys(row)))]
      const rows = this.values.map((row) => `(${columns.map((column) => valueSql(column, row[column])).join(', ')})`)
      sql = `insert into ${table} (${columns.map(ident).join(', ')}) values ${rows.join(', ')}`
      if (this.operation === 'upsert') {
        const conflict = this.upsertOptions.onConflict ? this.upsertOptions.onConflict.split(',').map((column) => column.trim()) : await this.client.primaryKey(this.table)
        const updates = columns.filter((column) => !conflict.includes(column))
        sql +=
          this.upsertOptions.ignoreDuplicates || !updates.length
            ? ` on conflict (${conflict.map(ident).join(', ')}) do nothing`
            : ` on conflict (${conflict.map(ident).join(', ')}) do update set ${updates.map((column) => `${ident(column)} = excluded.${ident(column)}`).join(', ')}`
      }
    }
    if (this.operation !== 'select') sql += ` returning ${this.returning ? this.selectList(this.returning) : '*'}`

    const result = await this.client.execute(sql, params)
    if (result.error) return { data: null, error: result.error, count: null }
    let rows = result.rows ?? []

    let count: number | null = null
    if (this.count === 'exact') {
      const countParams: unknown[] = []
      const countNext = (value: unknown) => {
        countParams.push(value instanceof Date ? value.toISOString() : value)
        return `$${countParams.length}`
      }
      const countWhere = this.filters.length ? ` where ${this.filters.map((filter) => `(${filter.sql(countNext)})`).join(' and ')}` : ''
      const counted = await this.client.execute(`select count(*)::int as n from ${table}${countWhere}`, countParams)
      if (counted.error) return { data: null, error: counted.error, count: null }
      count = (counted.rows?.[0]?.n as number) ?? 0
    }

    if (this.operation !== 'select' && this.returning === null) return { data: null, error: null, count }
    if (this.head) return { data: null, error: null, count }
    if (this.singleMode) {
      if (rows.length > 1 || (this.singleMode === 'one' && rows.length === 0)) {
        return { data: null, error: { code: 'PGRST116', message: `JSON object requested, ${rows.length} rows returned` }, count }
      }
      return { data: rows[0] ?? null, error: null, count }
    }
    rows = rows.map((row) => ({ ...row }))
    return { data: rows, error: null, count }
  }
}

function unsupported(column: string): never {
  throw new Error(`embedded resources are not supported by the test adapter: ${column}`)
}

const OPERATORS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' }

type LogicNode = { kind: 'and' | 'or'; items: LogicNode[] } | { kind: 'cond'; column: string; negate: boolean; op: string; value: string }

function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  if (current) parts.push(current)
  return parts
}

function parseLogic(expression: string): LogicNode[] {
  return splitTopLevel(expression).map((part) => {
    const group = /^(and|or)\((.*)\)$/.exec(part.trim())
    if (group) return { kind: group[1] as 'and' | 'or', items: parseLogic(group[2]!) }
    const [column, ...rest] = part.trim().split('.')
    let negate = false
    if (rest[0] === 'not') {
      negate = true
      rest.shift()
    }
    const op = rest.shift()!
    return { kind: 'cond', column: column!, negate, op, value: rest.join('.') }
  })
}

function renderLogic(node: LogicNode, next: (value: unknown) => string): string {
  if (node.kind !== 'cond') return `(${node.items.map((item) => renderLogic(item, next)).join(node.kind === 'and' ? ' and ' : ' or ')})`
  const column = columnExpr(node.column)
  let sql: string
  if (node.op === 'is') sql = `${column} is ${node.value === 'null' ? 'null' : node.value === 'true' ? 'true' : 'false'}`
  else if (node.op === 'in') sql = `${column} = any(${next(node.value.replace(/^\(|\)$/g, '').split(','))})`
  else if (OPERATORS[node.op]) sql = `${column} ${OPERATORS[node.op]} ${next(node.value)}`
  else throw new Error(`unsupported operator in or(): ${node.op}`)
  return node.negate ? `not (${sql})` : sql
}
