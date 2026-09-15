import type { Pool } from 'pg'
import type { AssistantProvider } from '../integrations/openai.js'
import { CircuitOpenError } from '../lib/circuit-breaker.js'
import { RateLimitWaitError } from '../lib/rate-limiter.js'

export class InsufficientCredits extends Error {
  constructor(
    public readonly balance: number,
    public readonly cost: number,
  ) {
    super(`insufficient credits: balance ${balance}, cost ${cost}`)
    this.name = 'InsufficientCredits'
  }
}

export class AssistantUnavailable extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message)
    this.name = 'AssistantUnavailable'
  }
}

export function createAssistant(pool: Pool, provider: AssistantProvider, cost: number) {
  return {
    /**
     * Charge-after-success: the upstream call happens first (no credits burned on an
     * outage), then the deduction and the audit row commit together. The balance row is
     * locked so two concurrent asks cannot both pass the check and overdraw; the CHECK
     * (balance >= 0) constraint is the final backstop.
     */
    async ask(userId: string, question: string) {
      const pre = await pool.query<{ balance: number }>('SELECT balance FROM users WHERE id = $1', [
        userId,
      ])
      const balance = pre.rows[0]?.balance ?? 0
      if (balance < cost) throw new InsufficientCredits(balance, cost)

      let completion
      try {
        completion = await provider.complete(question)
      } catch (err) {
        if (err instanceof CircuitOpenError)
          throw new AssistantUnavailable(err.message, err.retryAfterMs)
        if (err instanceof RateLimitWaitError)
          throw new AssistantUnavailable('assistant is busy', err.waitMs)
        throw err
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const locked = await client.query<{ balance: number }>(
          'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        )
        if ((locked.rows[0]?.balance ?? 0) < cost) {
          await client.query('ROLLBACK')
          throw new InsufficientCredits(locked.rows[0]?.balance ?? 0, cost)
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO completions (user_id, question, answer, model, tokens_used, cost)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [userId, question, completion.answer, completion.model, completion.tokensUsed, cost],
        )
        await client.query(
          `INSERT INTO ledger_entries (user_id, delta, reason, ref_type, ref_id)
           VALUES ($1, $2, 'ask', 'completion', $3)`,
          [userId, -cost, rows[0]!.id],
        )
        const after = await client.query<{ balance: number }>(
          'UPDATE users SET balance = balance - $2 WHERE id = $1 RETURNING balance',
          [userId, cost],
        )
        await client.query('COMMIT')
        return { ...completion, cost, balance: after.rows[0]!.balance, completionId: rows[0]!.id }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}

export type Assistant = ReturnType<typeof createAssistant>
