import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { createApp, type App } from '../src/app.js'
import { OpenAIClient } from '../src/integrations/openai.js'
import { FakeStripeGateway } from '../src/integrations/stripe.js'
import { TelegramNotifier } from '../src/integrations/telegram.js'

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://paygate:paygate@localhost:5432/paygate_test'
export const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests'

/**
 * Scriptable upstream: each request pops the next scripted response (or repeats the last).
 * Records every request so tests can assert how many times the real client actually called.
 */
export interface Scripted {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export class FakeUpstream {
  server: Server
  url = ''
  requests: { path: string; body: unknown }[] = []
  script: Scripted[] = []

  constructor() {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        this.requests.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null })
        const next =
          this.script.length > 1
            ? this.script.shift()!
            : (this.script[0] ?? { status: 200, body: {} })
        res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) })
        res.end(JSON.stringify(next.body))
      })
    })
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, r))
    this.url = `http://localhost:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  reset() {
    this.requests = []
    this.script = []
  }
}

export const openaiOk = (answer = 'Forty-two.') => ({
  status: 200,
  body: {
    model: 'gpt-test',
    choices: [{ message: { content: answer } }],
    usage: { total_tokens: 12 },
  },
})

export interface Harness {
  app: App
  stripe: FakeStripeGateway
  openai: FakeUpstream
  telegram: FakeUpstream
  sleeps: number[]
}

export async function bootHarness(config: Record<string, string> = {}): Promise<Harness> {
  const openai = await new FakeUpstream().start()
  const telegram = await new FakeUpstream().start()
  const stripe = new FakeStripeGateway(WEBHOOK_SECRET)
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  const breakerThreshold = 2
  const breakerResetMs = 300
  const app = await createApp({
    config: {
      NODE_ENV: 'test',
      PORT: '0',
      LOG_LEVEL: 'silent',
      DATABASE_URL: TEST_DATABASE_URL,
      STRIPE_SECRET_KEY: 'fake',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
      RATE_LIMIT_MAX: '5',
      RATE_LIMIT_WINDOW_MS: '60000',
      BREAKER_FAILURE_THRESHOLD: String(breakerThreshold),
      BREAKER_RESET_MS: String(breakerResetMs),
      ...config,
    },
    gateway: stripe,
    assistant: new OpenAIClient({
      baseUrl: openai.url,
      apiKey: 'test',
      model: 'gpt-test',
      rpm: 6000,
      breakerThreshold,
      breakerResetMs,
      sleep,
    }),
    telegram: new TelegramNotifier({
      baseUrl: telegram.url,
      botToken: 'bot-token',
      chatId: '42',
      breakerThreshold,
      breakerResetMs,
      sleep,
    }),
  })
  return { app, stripe, openai, telegram, sleeps }
}

export async function resetDb() {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL })
  await pool.query(
    'TRUNCATE users, orders, ledger_entries, webhook_events, idempotency_keys, completions CASCADE',
  )
  await pool.end()
}

export async function createUser(url: string, email = 'a@example.com') {
  const res = await fetch(`${url}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const body = (await res.json()) as { user: { id: string; balance: number }; apiKey: string }
  return {
    ...body,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${body.apiKey}` },
  }
}

export function checkoutCompletedEvent(
  orderId: string,
  sessionId: string,
  eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
) {
  return {
    id: eventId,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type: 'checkout.session.completed',
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: 'paid',
        client_reference_id: orderId,
        metadata: { orderId },
      },
    },
  }
}

export async function postWebhook(harness: Harness, event: object, signature?: string) {
  const payload = JSON.stringify(event)
  return fetch(`${harness.app.url}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature ?? harness.stripe.sign(payload),
    },
    body: payload,
  })
}

export const until = async (pred: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('condition not met')
}
