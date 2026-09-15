/**
 * Minimal forward-only SQL migrator. Files in ./migrations are applied in name order inside
 * a transaction each; applied names are recorded in `schema_migrations`. A Postgres advisory
 * lock makes it safe for several instances to start at once (only one will migrate).
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
)
const LOCK_KEY = 7_2_9_7_1_3 // arbitrary but stable

export async function migrate(
  pool: Pool,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    )
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
      applied.push(file)
      log(`applied ${file}`)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    client.release()
  }
  return applied
}

// `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { createPool } = await import('./pool.js')
  const { loadConfig } = await import('../config.js')
  const pool = createPool(loadConfig().DATABASE_URL)
  const applied = await migrate(pool, console.log)
  console.log(applied.length ? `done (${applied.length})` : 'nothing to apply')
  await pool.end()
}
