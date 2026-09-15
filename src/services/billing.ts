import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type Stripe from 'stripe'
import { PACKS, type Pack } from '../config.js'
import type { PaymentGateway } from '../integrations/stripe.js'

export interface Order {
  id: string
  user_id: string
  pack: string
  credits: number
  amount_cents: number
  currency: string
  status: 'pending' | 'paid' | 'expired'
  stripe_session_id: string | null
  paid_at: string | null
  created_at: string
}

export class IdempotencyConflict extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request body')
    this.name = 'IdempotencyConflict'
  }
}

export class IdempotencyInFlight extends Error {
  constructor() {
    super('a request with this Idempotency-Key is still being processed; retry shortly')
    this.name = 'IdempotencyInFlight'
  }
}

export interface BillingDeps {
  pool: Pool
  gateway: PaymentGateway
  publicUrl: string
  onPaid?: (order: Order, email: string) => Promise<void>
  log: (msg: string, fields?: Record<string, unknown>) => void
}

export function createBilling({ pool, gateway, publicUrl, onPaid, log }: BillingDeps) {
  const hashRequest = (body: unknown) =>
    createHash('sha256').update(JSON.stringify(body)).digest('hex')

  return {
    /**
     * Idempotent checkout. The client sends an `Idempotency-Key`; we store (user, key,
     * request hash, response). A retry with the same key and body returns the stored
     * response without creating a second order or a second Stripe session. The same key with
     * a different body is a client bug and gets a 422.
     */
    async createCheckout(
      userId: string,
      pack: Pack,
      idempotencyKey: string,
    ): Promise<{
      statusCode: number
      body: { order: Order; checkoutUrl: string }
      replayed: boolean
    }> {
      const requestHash = hashRequest({ pack })
      const existing = await pool.query<{
        request_hash: string
        status_code: number | null
        response: unknown
      }>(
        'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, idempotencyKey],
      )
      const prior = existing.rows[0]
      if (prior) {
        if (prior.request_hash !== requestHash) throw new IdempotencyConflict()
        if (prior.status_code && prior.response) {
          return { statusCode: prior.status_code, body: prior.response as never, replayed: true }
        }
        // Key reserved but no response yet: a concurrent first request is still in flight.
        throw new IdempotencyInFlight()
      }
      // Reserve the key first so a concurrent duplicate hits the PK and fails fast.
      const reserved = await pool.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, idempotencyKey, requestHash],
      )
      if (reserved.rowCount === 0) throw new IdempotencyInFlight()

      const { credits, amountCents, currency } = PACKS[pack]
      const { rows } = await pool.query<Order>(
        `INSERT INTO orders (user_id, pack, credits, amount_cents, currency)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [userId, pack, credits, amountCents, currency],
      )
      const order = rows[0]!
      const session = await gateway.createCheckoutSession({
        orderId: order.id,
        userId,
        credits,
        amountCents,
        currency,
        successUrl: `${publicUrl}/checkout/success?order=${order.id}`,
        cancelUrl: `${publicUrl}/checkout/cancel?order=${order.id}`,
        idempotencyKey: `checkout:${userId}:${idempotencyKey}`,
      })
      const updated = await pool.query<Order>(
        'UPDATE orders SET stripe_session_id = $2 WHERE id = $1 RETURNING *',
        [order.id, session.sessionId],
      )
      const body = { order: updated.rows[0]!, checkoutUrl: session.url }
      await pool.query(
        'UPDATE idempotency_keys SET status_code = 201, response = $3 WHERE user_id = $1 AND key = $2',
        [userId, idempotencyKey, JSON.stringify(body)],
      )
      log('checkout created', { orderId: order.id, userId, pack })
      return { statusCode: 201, body, replayed: false }
    },

    /**
     * Webhook entry point. Three layers make a redelivered or duplicated event harmless:
     *  1. `webhook_events.id` is the Stripe event id (PK) — a redelivery is a no-op insert.
     *  2. The order row is locked `FOR UPDATE` and its status checked inside the transaction.
     *  3. `ledger_entries (ref_type, ref_id)` is unique per order.
     * The event is marked processed only when the transaction commits; if we crash before
     * that, Stripe's retry finds the row unprocessed and runs the handler again.
     */
    async handleWebhookEvent(event: Stripe.Event): Promise<'processed' | 'duplicate' | 'ignored'> {
      const inserted = await pool.query(
        `INSERT INTO webhook_events (id, provider, type, payload) VALUES ($1, 'stripe', $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [event.id, event.type, JSON.stringify(event)],
      )
      if (inserted.rowCount === 0) {
        const { rows } = await pool.query<{ processed_at: string | null }>(
          'SELECT processed_at FROM webhook_events WHERE id = $1',
          [event.id],
        )
        if (rows[0]?.processed_at) {
          log('webhook duplicate ignored', { eventId: event.id, type: event.type })
          return 'duplicate'
        }
        // Inserted earlier but never finished: fall through and process it now.
      }

      let outcome: 'processed' | 'ignored' = 'ignored'
      let paidOrder: { order: Order; email: string } | null = null
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Serialise concurrent deliveries of the same event (Stripe can double-deliver).
        const locked = await client.query<{ processed_at: string | null }>(
          'SELECT processed_at FROM webhook_events WHERE id = $1 FOR UPDATE',
          [event.id],
        )
        if (locked.rows[0]?.processed_at) {
          await client.query('ROLLBACK')
          return 'duplicate'
        }

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as Stripe.Checkout.Session
          if (session.payment_status === 'paid') {
            paidOrder = await applyPayment(client, session)
            outcome = 'processed'
          }
        } else if (event.type === 'checkout.session.expired') {
          const session = event.data.object as Stripe.Checkout.Session
          await client.query(
            `UPDATE orders SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'`,
            [session.id],
          )
          outcome = 'processed'
        }

        await client.query(
          'UPDATE webhook_events SET processed_at = now(), error = NULL WHERE id = $1',
          [event.id],
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        await pool.query('UPDATE webhook_events SET error = $2 WHERE id = $1', [
          event.id,
          String(err),
        ])
        throw err
      } finally {
        client.release()
      }

      if (paidOrder && onPaid) {
        // Side effects (Telegram) run after commit and never block the 200 to Stripe.
        void onPaid(paidOrder.order, paidOrder.email).catch((err) =>
          log('post-payment hook failed', { orderId: paidOrder!.order.id, error: String(err) }),
        )
      }
      return outcome
    },

    async getOrder(userId: string, orderId: string): Promise<Order | null> {
      const { rows } = await pool.query<Order>(
        'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
        [orderId, userId],
      )
      return rows[0] ?? null
    },
  }

  async function applyPayment(
    client: PoolClient,
    session: Stripe.Checkout.Session,
  ): Promise<{ order: Order; email: string } | null> {
    const orderId = session.metadata?.orderId ?? session.client_reference_id
    if (!orderId) throw new Error(`session ${session.id} carries no orderId`)
    const { rows } = await client.query<Order & { email: string }>(
      `SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.id = $1 FOR UPDATE OF o`,
      [orderId],
    )
    const order = rows[0]
    if (!order) throw new Error(`order ${orderId} not found for session ${session.id}`)
    if (order.status === 'paid') {
      log('order already paid', { orderId })
      return null
    }
    // Trust our own record of what was sold, not the webhook payload, for the credit amount.
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta, reason, ref_type, ref_id)
       VALUES ($1, $2, 'purchase', 'order', $3)`,
      [order.user_id, order.credits, order.id],
    )
    await client.query('UPDATE users SET balance = balance + $2 WHERE id = $1', [
      order.user_id,
      order.credits,
    ])
    const updated = await client.query<Order>(
      `UPDATE orders SET status = 'paid', paid_at = now(), stripe_session_id = COALESCE(stripe_session_id, $2)
       WHERE id = $1 RETURNING *`,
      [order.id, session.id],
    )
    log('payment applied', { orderId: order.id, credits: order.credits })
    return { order: updated.rows[0]!, email: order.email }
  }
}

export type Billing = ReturnType<typeof createBilling>
