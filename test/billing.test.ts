import Stripe from 'stripe'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootHarness,
  checkoutCompletedEvent,
  createUser,
  postWebhook,
  resetDb,
  until,
  WEBHOOK_SECRET,
  type Harness,
} from './helpers.js'

let h: Harness
beforeAll(async () => {
  h = await bootHarness()
})
afterAll(async () => {
  await h.app.close()
  await h.openai.stop()
  await h.telegram.stop()
})
beforeEach(async () => {
  await resetDb()
  h.openai.reset()
  h.telegram.reset()
  h.stripe.sessions = []
  h.sleeps.length = 0
})

async function checkout(headers: Record<string, string>, key: string, pack = 'small') {
  return fetch(`${h.app.url}/checkout`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': key },
    body: JSON.stringify({ pack }),
  })
}

describe('users + auth', () => {
  it('issues an API key once and authenticates with it', async () => {
    const { apiKey, headers, user } = await createUser(h.app.url)
    expect(apiKey).toMatch(/^pg_/)
    expect(user.balance).toBe(0)
    const me = await fetch(`${h.app.url}/me`, { headers })
    expect(me.status).toBe(200)
    expect(
      (await fetch(`${h.app.url}/me`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401)
    expect(
      (
        await fetch(`${h.app.url}/users`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'a@example.com' }),
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await fetch(`${h.app.url}/users`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'nope' }),
        })
      ).status,
    ).toBe(422)
  })

  it('rate-limits per API key', async () => {
    const { headers } = await createUser(h.app.url)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await fetch(`${h.app.url}/me`, { headers })).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  })
})

describe('checkout idempotency', () => {
  it('requires an Idempotency-Key and validates the pack', async () => {
    const { headers } = await createUser(h.app.url)
    const noKey = await fetch(`${h.app.url}/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pack: 'small' }),
    })
    expect(noKey.status).toBe(400)
    expect((await checkout(headers, 'key-0000001', 'huge')).status).toBe(422)
  })

  it('replays the same response for a retried request and creates one Stripe session', async () => {
    const { headers } = await createUser(h.app.url)
    const first = await checkout(headers, 'key-0000001')
    expect(first.status).toBe(201)
    expect(first.headers.get('idempotent-replayed')).toBe('false')
    const a = (await first.json()) as { order: { id: string }; checkoutUrl: string }

    const second = await checkout(headers, 'key-0000001')
    expect(second.status).toBe(201)
    expect(second.headers.get('idempotent-replayed')).toBe('true')
    const b = (await second.json()) as { order: { id: string } }
    expect(b.order.id).toBe(a.order.id)
    expect(h.stripe.sessions).toHaveLength(1)
    expect(h.stripe.sessions[0]!.idempotencyKey).toContain('key-0000001')

    // Same key, different body → client bug.
    expect((await checkout(headers, 'key-0000001', 'large')).status).toBe(422)
  })

  it('concurrent duplicates: exactly one wins, the other is told to retry', async () => {
    const { headers } = await createUser(h.app.url)
    const [r1, r2] = await Promise.all([
      checkout(headers, 'key-race-01'),
      checkout(headers, 'key-race-01'),
    ])
    // Either the loser sees the reserved key while the winner is in flight (409) or, if the
    // winner already finished, gets the stored response replayed (201). Never two orders.
    const statuses = [r1.status, r2.status].sort()
    expect([[201, 201].join(), [201, 409].join()]).toContain(statuses.join())
    if (statuses[1] === 201) {
      expect([r1, r2].filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(
        1,
      )
    }
    expect(h.stripe.sessions).toHaveLength(1)
  })
})

describe('stripe webhooks', () => {
  async function paidOrder() {
    const user = await createUser(h.app.url)
    const res = await checkout(user.headers, 'key-0000009')
    const { order } = (await res.json()) as { order: { id: string; stripe_session_id: string } }
    return { user, order }
  }

  it('rejects missing, forged and stale signatures', async () => {
    const { order } = await paidOrder()
    const event = checkoutCompletedEvent(order.id, order.stripe_session_id)
    const payload = JSON.stringify(event)

    const missing = await fetch(`${h.app.url}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    expect(missing.status).toBe(400)

    const forged = new Stripe('sk_test_x', {
      apiVersion: '2024-06-20',
    }).webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' })
    expect((await postWebhook(h, event, forged)).status).toBe(400)

    const stale = new Stripe('sk_test_x', {
      apiVersion: '2024-06-20',
    }).webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    })
    expect((await postWebhook(h, event, stale)).status).toBe(400)

    // Tampered body with a signature for the original payload.
    const tampered = {
      ...event,
      data: { object: { ...event.data.object, metadata: { orderId: 'other' } } },
    }
    expect((await postWebhook(h, tampered, h.stripe.sign(payload))).status).toBe(400)

    const me = await (
      await fetch(`${h.app.url}/me`, {
        headers: (await createUser(h.app.url, 'z@example.com')).headers,
      })
    ).json()
    expect((me as { user: { balance: number } }).user.balance).toBe(0)
  })

  it('credits the balance exactly once across redeliveries and duplicate events', async () => {
    const { user, order } = await paidOrder()
    const event = checkoutCompletedEvent(order.id, order.stripe_session_id, 'evt_once')

    const first = await postWebhook(h, event)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ received: true, outcome: 'processed' })

    // Stripe redelivers the same event id.
    const again = await postWebhook(h, event)
    expect(await again.json()).toEqual({ received: true, outcome: 'duplicate' })

    // A different event for the same order (e.g. async_payment_succeeded → also "completed").
    const other = await postWebhook(
      h,
      checkoutCompletedEvent(order.id, order.stripe_session_id, 'evt_other'),
    )
    expect((await other.json()).outcome).toBe('processed')

    // Parallel double delivery.
    const parallel = await Promise.all([
      postWebhook(h, checkoutCompletedEvent(order.id, order.stripe_session_id, 'evt_par')),
      postWebhook(h, checkoutCompletedEvent(order.id, order.stripe_session_id, 'evt_par')),
    ])
    expect(parallel.map((r) => r.status)).toEqual([200, 200])

    const me = (await (await fetch(`${h.app.url}/me`, { headers: user.headers })).json()) as {
      user: { balance: number }
      ledger: { delta: number; reason: string }[]
    }
    expect(me.user.balance).toBe(100)
    expect(me.ledger).toHaveLength(1)
    expect(me.ledger[0]).toMatchObject({ delta: 100, reason: 'purchase' })

    const o = (await (
      await fetch(`${h.app.url}/orders/${order.id}`, { headers: user.headers })
    ).json()) as { status: string }
    expect(o.status).toBe('paid')
  })

  it('notifies Telegram after a payment, honouring retry_after on 429', async () => {
    const { order } = await paidOrder()
    h.telegram.script = [
      { status: 429, body: { ok: false, parameters: { retry_after: 2 } } },
      { status: 200, body: { ok: true } },
    ]
    await postWebhook(h, checkoutCompletedEvent(order.id, order.stripe_session_id))
    await until(() => h.telegram.requests.length === 2)
    expect(h.telegram.requests[0]!.path).toBe('/botbot-token/sendMessage')
    expect((h.telegram.requests[1]!.body as { text: string }).text).toContain('100')
    expect(h.sleeps).toContain(2000) // retry_after: 2 → waited exactly 2 s, not a backoff guess
  })

  it('ignores unrelated event types but records them', async () => {
    const res = await postWebhook(h, {
      ...checkoutCompletedEvent('x', 'y', 'evt_unrelated'),
      type: 'customer.created',
    })
    expect((await res.json()).outcome).toBe('ignored')
  })
})

describe('telegram webhook', () => {
  it('requires the shared secret and answers /stats', async () => {
    const body = JSON.stringify({ message: { chat: { id: 42 }, text: '/stats' } })
    const unauth = await fetch(`${h.app.url}/webhooks/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(unauth.status).toBe(401)
    const ok = await fetch(`${h.app.url}/webhooks/telegram`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'tg-secret',
      },
      body,
    })
    expect(ok.status).toBe(200)
    expect((h.telegram.requests[0]!.body as { text: string }).text).toContain('users: 0')
  })
})
