// A small in-memory stand-in for the Supabase client: enough of the
// PostgREST query builder (select/insert/upsert/update/delete with
// eq/neq/in/is/gt/lt/or filters), rpc and storage for server code under test. It records every
// table query with its filters so tests can assert that each one was scoped
// to an organization. It does not implement RLS — that is tested in pgTAP.

type Row = Record<string, unknown>

export interface RecordedQuery {
  table: string
  operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete'
  filters: [string, string, unknown][]
  values?: Row | Row[]
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {}
  queries: RecordedQuery[] = []
  rpcCalls: { name: string; args: Record<string, unknown> }[] = []
  rpcHandlers: Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }> = {}
  files = new Map<string, Uint8Array>()
  /** Called before each update is applied; lets a test change state mid-run. */
  beforeUpdate?: (table: string, values: Row) => void
  /** Return an error to make a table operation fail (e.g. an RLS refusal). */
  errorFor?: (table: string, operation: RecordedQuery['operation']) => { code: string; message?: string } | null
  removedFiles: string[] = []
  /** Column sets that must be unique per table; an insert that repeats one fails with 23505. */
  uniqueKeys: Record<string, string[][]> = {}
  private ids = 0

  rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args })
    const handler = this.rpcHandlers[name]
    return Promise.resolve(handler ? handler(args) : { data: null, error: { code: 'PGRST202', message: 'no handler' } })
  }

  from(table: string) {
    return new FakeQuery(this, table)
  }

  get storage() {
    return {
      from: (bucket: string) => ({
        list: async (folder: string, options?: { search?: string }) => {
          const prefix = `${bucket}/${folder}/`
          const data = [...this.files.entries()]
            .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
            .map(([key, bytes]) => ({ name: key.slice(prefix.length), metadata: { size: bytes.byteLength } }))
            .filter((entry) => !options?.search || entry.name.includes(options.search))
          return { data, error: null }
        },
        remove: async (paths: string[]) => {
          for (const path of paths) {
            this.removedFiles.push(path)
            this.files.delete(`${bucket}/${path}`)
          }
          return { data: [], error: null }
        },
        download: async (path: string) => {
          const bytes = this.files.get(`${bucket}/${path}`)
          return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { statusCode: '404', message: 'Object not found' } }
        },
      }),
    }
  }

  nextId(): string {
    this.ids += 1
    return `00000000-0000-4000-8000-${String(this.ids).padStart(12, '0')}`
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private operation: RecordedQuery['operation'] = 'select'
  private filters: [string, string, unknown][] = []
  private values: Row | Row[] | undefined
  private singleMode: false | 'maybe' | 'one' = false
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {}

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select() {
    return this
  }
  insert(values: Row | Row[]) {
    this.operation = 'insert'
    this.values = values
    return this
  }
  upsert(values: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.operation = 'upsert'
    this.values = values
    this.upsertOptions = options
    return this
  }
  update(values: Row) {
    this.operation = 'update'
    this.values = values
    return this
  }
  delete() {
    this.operation = 'delete'
    return this
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, 'eq', value])
    return this
  }
  neq(column: string, value: unknown) {
    this.filters.push([column, 'neq', value])
    return this
  }
  in(column: string, value: unknown[]) {
    this.filters.push([column, 'in', value])
    return this
  }
  is(column: string, value: null) {
    this.filters.push([column, 'is', value])
    return this
  }
  gt(column: string, value: unknown) {
    this.filters.push([column, 'gt', value])
    return this
  }
  lt(column: string, value: unknown) {
    this.filters.push([column, 'lt', value])
    return this
  }
  /** Supports "col.is.null,col.lt.value" style alternatives. */
  or(expression: string) {
    this.filters.push(['', 'or', expression])
    return this
  }
  order() {
    return this
  }
  limit() {
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

  private static test(row: Row, column: string, operator: string, value: unknown): boolean {
    const cell = row[column]
    switch (operator) {
      case 'eq':
        return cell === value
      case 'neq':
        return cell !== value
      case 'in':
        return (value as unknown[]).includes(cell)
      case 'is':
        return cell === null || cell === undefined
      case 'gt':
        return cell !== null && cell !== undefined && String(cell) > String(value)
      case 'lt':
        return cell !== null && cell !== undefined && String(cell) < String(value)
      case 'or':
        return String(value)
          .split(',')
          .some((part) => {
            const [col, op, ...rest] = part.split('.')
            const operand = rest.join('.')
            return FakeQuery.test(row, col!, op!, op === 'is' ? null : operand)
          })
      default:
        throw new Error(`unsupported operator ${operator}`)
    }
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, operator, value]) => FakeQuery.test(row, column, operator, value))
  }

  private violatesUnique(rows: Row[], candidate: Row): boolean {
    return (this.db.uniqueKeys[this.table] ?? []).some((columns) =>
      rows.some((row) => columns.every((column) => row[column] !== undefined && row[column] !== null && row[column] === candidate[column])),
    )
  }

  private result(data: Row[]): { data: unknown; error: unknown } {
    if (this.singleMode === 'maybe') return { data: data[0] ? { ...data[0] } : null, error: null }
    if (this.singleMode === 'one') {
      return data[0] ? { data: { ...data[0] }, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    }
    return { data: data.map((row) => ({ ...row })), error: null }
  }

  private run(): { data: unknown; error: unknown } {
    this.db.queries.push({ table: this.table, operation: this.operation, filters: this.filters, ...(this.values ? { values: this.values } : {}) })
    const failure = this.db.errorFor?.(this.table, this.operation)
    if (failure) return { data: null, error: failure }
    const rows = (this.db.tables[this.table] ??= [])
    if (this.operation === 'insert') {
      const candidates = (Array.isArray(this.values) ? this.values : [this.values!]).map((row) => ({ id: this.db.nextId(), ...row }))
      for (const candidate of candidates) {
        if (this.violatesUnique(rows, candidate)) return { data: null, error: { code: '23505', message: 'duplicate key value' } }
      }
      rows.push(...candidates)
      return this.result(candidates)
    }
    if (this.operation === 'upsert') {
      const conflict = (this.upsertOptions.onConflict ?? 'id').split(',').map((column) => column.trim())
      const written: Row[] = []
      for (const value of Array.isArray(this.values) ? this.values : [this.values!]) {
        const existing = rows.find((row) => conflict.every((column) => row[column] === value[column]))
        if (existing) {
          if (this.upsertOptions.ignoreDuplicates) continue
          Object.assign(existing, value)
          written.push(existing)
        } else {
          const row = { id: this.db.nextId(), ...value }
          rows.push(row)
          written.push(row)
        }
      }
      return this.result(written)
    }
    const matched = rows.filter((row) => this.matches(row))
    if (this.operation === 'update') {
      this.db.beforeUpdate?.(this.table, this.values as Row)
      const stillMatched = rows.filter((row) => this.matches(row))
      for (const row of stillMatched) Object.assign(row, this.values)
      return this.result(stillMatched)
    }
    if (this.operation === 'delete') {
      this.db.tables[this.table] = rows.filter((row) => !matched.includes(row))
      return { data: matched, error: null }
    }
    return this.result(matched)
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onfulfilled, onrejected)
  }
}
