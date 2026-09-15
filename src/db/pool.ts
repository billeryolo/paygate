import pg from 'pg'

// Return bigint columns (message ids) as JS numbers; they will never exceed 2^53 here.
pg.types.setTypeParser(20, (v) => Number(v))

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 })
}

export type Pool = pg.Pool
