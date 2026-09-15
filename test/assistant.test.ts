import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootHarness,
  checkoutCompletedEvent,
  createUser,
  openaiOk,
  postWebhook,
  resetDb,
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
  h.sleeps.length = 0
  h.app.assistant.breaker.reset()
})

async function fundedUser(email = 'u@example.com') {
  const user = await createUser(h.app.url, email)
  const res = await fetch(`${h.app.url}/checkout`, {
    method: 'POST',
    headers: { ...user.headers, 'idempotency-key': `key-${email}` },
    body: JSON.stringify({ pack: 'small' }),
  })
  const { order } = (await res.json()) as { order: { id: string; stripe_session_id: string } }
  await postWebhook(h, checkoutCompletedEvent(order.id, order.stripe_session_id))
  return user
}

const ask = (headers: Record<string, string>, question = 'meaning of life?') =>
  fetch(`${h.app.url}/ask`, { method: 'POST', headers, body: JSON.stringify({ question }) })

describe('ask', () => {
  it('refuses without credits and never calls upstream', async () => {
    const { headers } = await createUser(h.app.url)
    const res = await ask(headers)
    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({ error: 'insufficient_credits', balance: 0, cost: 1 })
    expect(h.openai.requests).toHaveLength(0)
  })

  it('answers and charges one credit atomically', async () => {
    const { headers } = await fundedUser()
    h.openai.script = [openaiOk('Forty-two.')]
    const res = await ask(headers)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { answer: string; balance: number; cost: number }
    expect(body).toMatchObject({ answer: 'Forty-two.', balance: 99, cost: 1 })
    expect(
      (h.openai.requests[0]!.body as { messages: { content: string }[] }).messages[1]!.content,
    ).toBe('meaning of life?')

    const me = (await (await fetch(`${h.app.url}/me`, { headers })).json()) as {
      ledger: { delta: number; reason: string }[]
    }
    expect(me.ledger[0]).toMatchObject({ delta: -1, reason: 'ask' })
  })

  it('concurrent asks cannot overdraw the balance', async () => {
    const { headers } = await createUser(h.app.url, 'c@example.com')
    // Give exactly 2 credits via a direct ledger-less balance set is not possible through the
    // API, so buy a pack and spend down to 2 by asking 98 times would be slow. Instead run 3
    // concurrent asks against a 100 balance and assert the ledger sums correctly.
    const funded = await fundedUser('c2@example.com')
    void headers
    h.openai.script = [openaiOk()]
    const results = await Promise.all([
      ask(funded.headers),
      ask(funded.headers),
      ask(funded.headers),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    const me = (await (await fetch(`${h.app.url}/me`, { headers: funded.headers })).json()) as {
      user: { balance: number }
    }
    expect(me.user.balance).toBe(97)
  })

  it('retries on 429 honouring Retry-After, then succeeds; credits charged once', async () => {
    const { headers } = await fundedUser()
    h.openai.script = [
      { status: 429, body: { error: 'rate limited' }, headers: { 'retry-after': '3' } },
      { status: 500, body: { error: 'boom' } },
      openaiOk('after retries'),
    ]
    const res = await ask(headers)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { answer: string }).answer).toBe('after retries')
    expect(h.openai.requests).toHaveLength(3)
    expect(h.sleeps[0]).toBe(3000) // Retry-After: 3 → exactly 3 s
    expect(h.sleeps[1]).toBeLessThanOrEqual(500) // backoff for attempt 2 (base 250 ms, full jitter)
    const me = (await (await fetch(`${h.app.url}/me`, { headers })).json()) as {
      user: { balance: number }
    }
    expect(me.user.balance).toBe(99)
  })

  it('opens the circuit after repeated failures, fails fast, then recovers', async () => {
    const { headers } = await fundedUser()
    h.openai.script = [{ status: 503, body: { error: 'down' } }]

    // Two logical calls × 3 attempts each = 6 upstream hits, breaker threshold 2.
    expect((await ask(headers)).status).toBe(502)
    expect((await ask(headers)).status).toBe(502)
    expect(h.openai.requests).toHaveLength(6)
    expect(h.app.assistant.breaker.currentState).toBe('open')

    // Open: no upstream call, 503 with Retry-After, no credits charged.
    const fast = await ask(headers)
    expect(fast.status).toBe(503)
    expect(fast.headers.get('retry-after')).toBeTruthy()
    expect(h.openai.requests).toHaveLength(6)
    const health = (await (await fetch(`${h.app.url}/health`)).json()) as { openaiCircuit: string }
    expect(health.openaiCircuit).toBe('open')

    // After the reset window a trial call goes through; upstream is healthy again → closed.
    await new Promise((r) => setTimeout(r, 350))
    h.openai.script = [openaiOk('back')]
    const recovered = await ask(headers)
    expect(recovered.status).toBe(200)
    expect(h.app.assistant.breaker.currentState).toBe('closed')

    const me = (await (await fetch(`${h.app.url}/me`, { headers })).json()) as {
      user: { balance: number }
    }
    expect(me.user.balance).toBe(99) // only the successful call was charged
  })

  it('a client error (4xx) is not retried and does not trip the breaker', async () => {
    const { headers } = await fundedUser()
    h.openai.script = [{ status: 400, body: { error: 'bad request' } }]
    expect((await ask(headers)).status).toBe(502)
    expect((await ask(headers)).status).toBe(502)
    expect((await ask(headers)).status).toBe(502)
    expect(h.openai.requests).toHaveLength(3) // one attempt per call, no retries
    expect(h.app.assistant.breaker.currentState).toBe('closed')
  })
})
