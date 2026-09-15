import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export interface User {
  id: string
  email: string
  balance: number
  created_at: string
}

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function createUsers(pool: Pool) {
  return {
    /** Returns the plaintext API key exactly once; only its hash is stored. */
    async create(email: string): Promise<{ user: User; apiKey: string }> {
      const apiKey = `pg_${randomBytes(24).toString('base64url')}`
      const { rows } = await pool.query<User>(
        `INSERT INTO users (email, api_key_hash) VALUES ($1, $2)
         RETURNING id, email, balance, created_at`,
        [email.toLowerCase(), hashKey(apiKey)],
      )
      return { user: rows[0]!, apiKey }
    },

    async byApiKey(apiKey: string): Promise<User | null> {
      const { rows } = await pool.query<User>(
        'SELECT id, email, balance, created_at FROM users WHERE api_key_hash = $1',
        [hashKey(apiKey)],
      )
      return rows[0] ?? null
    },

    async byId(id: string): Promise<User | null> {
      const { rows } = await pool.query<User>(
        'SELECT id, email, balance, created_at FROM users WHERE id = $1',
        [id],
      )
      return rows[0] ?? null
    },

    async ledger(userId: string, limit = 50) {
      const { rows } = await pool.query(
        `SELECT id, delta, reason, ref_type, ref_id, created_at FROM ledger_entries
         WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
        [userId, limit],
      )
      return rows
    },

    async stats() {
      const { rows } = await pool.query<{
        users: number
        paid_orders: number
        revenue_cents: number
        credits_spent: number
      }>(
        `SELECT (SELECT count(*) FROM users)::int AS users,
                (SELECT count(*) FROM orders WHERE status = 'paid')::int AS paid_orders,
                (SELECT coalesce(sum(amount_cents), 0) FROM orders WHERE status = 'paid')::int AS revenue_cents,
                (SELECT coalesce(-sum(delta), 0) FROM ledger_entries WHERE delta < 0)::int AS credits_spent`,
      )
      return rows[0]!
    },
  }
}

export type Users = ReturnType<typeof createUsers>
