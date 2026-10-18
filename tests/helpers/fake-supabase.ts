// A small in-memory stand-in for the Supabase client: enough of the
// PostgREST query builder (select/insert/update/delete with eq/neq/in
// filters), rpc and storage for server code under test. It records every
// table query with its filters so tests can assert that each one was scoped
// to an organization. It does not implement RLS — that is tested in pgTAP.

type Row = Record<string, unknown>

export interface RecordedQuery {
  table: string
  operation: 'select' | 'insert' | 'update' | 'delete'
  filters: [string, string, unknown][]
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
  private single = false

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
  order() {
    return this
  }
  limit() {
    return this
  }
  maybeSingle() {
    this.single = true
    return this
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, operator, value]) =>
      operator === 'eq' ? row[column] === value : operator === 'neq' ? row[column] !== value : (value as unknown[]).includes(row[column]),
    )
  }

  private run(): { data: unknown; error: unknown } {
    this.db.queries.push({ table: this.table, operation: this.operation, filters: this.filters })
    const failure = this.db.errorFor?.(this.table, this.operation)
    if (failure) return { data: null, error: failure }
    const rows = (this.db.tables[this.table] ??= [])
    if (this.operation === 'insert') {
      const inserted = (Array.isArray(this.values) ? this.values : [this.values!]).map((row) => ({ id: this.db.nextId(), ...row }))
      rows.push(...inserted)
      return { data: inserted, error: null }
    }
    const matched = rows.filter((row) => this.matches(row))
    if (this.operation === 'update') {
      this.db.beforeUpdate?.(this.table, this.values as Row)
      const stillMatched = rows.filter((row) => this.matches(row))
      for (const row of stillMatched) Object.assign(row, this.values)
      return { data: stillMatched.map((row) => ({ ...row })), error: null }
    }
    if (this.operation === 'delete') {
      this.db.tables[this.table] = rows.filter((row) => !matched.includes(row))
      return { data: matched, error: null }
    }
    if (this.single) return { data: matched[0] ? { ...matched[0] } : null, error: null }
    return { data: matched.map((row) => ({ ...row })), error: null }
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
