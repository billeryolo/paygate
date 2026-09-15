import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { Redis } from 'ioredis'
import * as Sentry from '@sentry/node'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { loadConfig, PACKS, type Config } from './config.js'
import { migrate } from './db/migrate.js'
import { createPool } from './db/pool.js'
import { OpenAIClient, type AssistantProvider } from './integrations/openai.js'
import { FakeStripeGateway, StripeGateway, type PaymentGateway } from './integrations/stripe.js'
import { TelegramNotifier } from './integrations/telegram.js'
import { AssistantUnavailable, createAssistant, InsufficientCredits } from './services/assistant.js'
import { createBilling, IdempotencyConflict, IdempotencyInFlight } from './services/billing.js'
import { HttpError } from './lib/http.js'
import { createUsers, type User } from './services/users.js'

export interface AppOptions {
  config?: Partial<Record<keyof Config, string>>
  gateway?: PaymentGateway
  assistant?: AssistantProvider
  telegram?: TelegramNotifier
}

export interface App {
  server: FastifyInstance
  config: Config
  gateway: PaymentGateway
  assistant: AssistantProvider
  telegram: TelegramNotifier
  url: string
  close(): Promise<void>
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
  }
}

const emailSchema = z.object({ email: z.string().email().max(255) })
const checkoutSchema = z.object({ pack: z.enum(Object.keys(PACKS) as [keyof typeof PACKS]) })
const askSchema = z.object({ question: z.string().trim().min(1).max(2000) })
const telegramUpdateSchema = z.object({
  message: z
    .object({
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      text: z.string().optional(),
    })
    .optional(),
})

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const config = loadConfig(opts.config)
  const server = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["stripe-signature"]'],
    },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    trustProxy: true,
  })
  const log = (msg: string, fields: Record<string, unknown> = {}) => server.log.info(fields, msg)

  if (config.SENTRY_DSN) {
    Sentry.init({ dsn: config.SENTRY_DSN, environment: config.NODE_ENV, tracesSampleRate: 0.1 })
    Sentry.setupFastifyErrorHandler(server)
  }

  const pool = createPool(config.DATABASE_URL)
  await migrate(pool, (m) => server.log.info(m))
  const users = createUsers(pool)

  const gateway =
    opts.gateway ??
    (config.STRIPE_SECRET_KEY.startsWith('sk_')
      ? new StripeGateway(
          config.STRIPE_SECRET_KEY,
          config.STRIPE_WEBHOOK_SECRET,
          config.STRIPE_WEBHOOK_TOLERANCE,
        )
      : new FakeStripeGateway(config.STRIPE_WEBHOOK_SECRET))
  const telegram = opts.telegram ?? TelegramNotifier.fromConfig(config, { log })
  const assistantProvider = opts.assistant ?? OpenAIClient.fromConfig(config, { log })

  const billing = createBilling({
    pool,
    gateway,
    publicUrl: config.PUBLIC_URL,
    log,
    onPaid: (order, email) =>
      telegram.notify(
        `💳 <b>Payment received</b>\n${email} bought <b>${order.credits}</b> credits ` +
          `(${(order.amount_cents / 100).toFixed(2)} ${order.currency.toUpperCase()})\norder <code>${order.id}</code>`,
      ),
  })
  const assistant = createAssistant(pool, assistantProvider, config.ASK_COST_CREDITS)

  // --- inbound rate limiting (per API key, shared via Redis when available) ---------------
  let redis: Redis | null = null
  if (config.REDIS_URL) {
    redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    await redis.connect()
  }
  await server.register(rateLimit, {
    global: false,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis: redis ?? undefined,
    keyGenerator: (req) => (req.headers.authorization as string | undefined) ?? req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `too many requests; retry in ${Math.ceil(ctx.ttl / 1000)}s`,
    }),
  })

  // --- auth ---------------------------------------------------------------------------------
  const requireApiKey = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? ''
    const key = header.startsWith('Bearer ') ? header.slice(7) : ''
    const user = key ? await users.byApiKey(key) : null
    if (!user) return reply.code(401).send({ error: 'unauthorized' })
    req.user = user
  }

  // --- error mapping ------------------------------------------------------------------------
  server.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError)
      return reply.code(422).send({ error: 'validation', issues: err.issues })
    if (err instanceof IdempotencyConflict)
      return reply.code(422).send({ error: 'idempotency_conflict', message: err.message })
    if (err instanceof IdempotencyInFlight)
      return reply.code(409).send({ error: 'idempotency_in_flight', message: err.message })
    if (err instanceof HttpError) {
      req.log.warn({ status: err.status }, 'upstream error')
      return reply
        .code(502)
        .send({ error: 'upstream_error', message: `upstream returned ${err.status}` })
    }
    if (err instanceof InsufficientCredits)
      return reply
        .code(402)
        .send({ error: 'insufficient_credits', balance: err.balance, cost: err.cost })
    if (err instanceof AssistantUnavailable) {
      reply.header('retry-after', Math.ceil(err.retryAfterMs / 1000))
      return reply.code(503).send({ error: 'assistant_unavailable', message: err.message })
    }
    if ((err as { statusCode?: number }).statusCode === 429)
      return reply.code(429).send({ error: 'rate_limited', message: err.message })
    req.log.error({ err }, 'unhandled error')
    reply.code(500).send({ error: 'internal', requestId: req.id })
  })

  server.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  // --- routes -------------------------------------------------------------------------------
  server.get('/health', async (_req, reply) => {
    const checks: Record<string, string> = {}
    try {
      await pool.query('SELECT 1')
      checks.postgres = 'ok'
    } catch (err) {
      checks.postgres = `error: ${(err as Error).message}`
    }
    checks.openaiCircuit = assistantProvider.breaker.currentState
    checks.telegramCircuit = telegram.breaker.currentState
    const ok = checks.postgres === 'ok'
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', ...checks })
  })

  server.get('/packs', async () => PACKS)

  server.post('/users', async (req, reply) => {
    const { email } = emailSchema.parse(req.body)
    try {
      const created = await users.create(email)
      return reply.code(201).send(created)
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        return reply.code(409).send({ error: 'email_taken' })
      throw err
    }
  })

  server.register(async (authed) => {
    authed.addHook('preHandler', requireApiKey)

    authed.get('/me', { config: { rateLimit: {} } }, async (req) => ({
      user: req.user,
      ledger: await users.ledger(req.user!.id),
    }))

    authed.post('/checkout', { config: { rateLimit: {} } }, async (req, reply) => {
      const { pack } = checkoutSchema.parse(req.body)
      const key = req.headers['idempotency-key']
      if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
        return reply.code(400).send({
          error: 'missing_idempotency_key',
          message: 'Idempotency-Key header (8–128 chars) required',
        })
      }
      const result = await billing.createCheckout(req.user!.id, pack, key)
      reply.header('idempotent-replayed', String(result.replayed))
      return reply.code(result.statusCode).send(result.body)
    })

    authed.get('/orders/:id', async (req, reply) => {
      const order = await billing.getOrder(req.user!.id, (req.params as { id: string }).id)
      return order ?? reply.code(404).send({ error: 'not_found' })
    })

    authed.post('/ask', { config: { rateLimit: {} } }, async (req) => {
      const { question } = askSchema.parse(req.body)
      return assistant.ask(req.user!.id, question)
    })
  })

  // Webhooks need the raw body for signature verification, so JSON parsing is bypassed here.
  server.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    )

    hooks.post('/webhooks/stripe', async (req, reply) => {
      const signature = req.headers['stripe-signature']
      if (typeof signature !== 'string') return reply.code(400).send({ error: 'missing_signature' })
      let event
      try {
        event = gateway.parseWebhook(req.body as Buffer, signature)
      } catch (err) {
        req.log.warn({ err: String(err) }, 'stripe signature rejected')
        return reply.code(400).send({ error: 'invalid_signature' })
      }
      const outcome = await billing.handleWebhookEvent(event)
      return { received: true, outcome }
    })

    hooks.post('/webhooks/telegram', async (req, reply) => {
      // Telegram sends the secret configured with setWebhook back in this header.
      if (
        !config.TELEGRAM_WEBHOOK_SECRET ||
        req.headers['x-telegram-bot-api-secret-token'] !== config.TELEGRAM_WEBHOOK_SECRET
      ) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
      const update = telegramUpdateSchema.parse(JSON.parse((req.body as Buffer).toString('utf8')))
      const text = update.message?.text?.trim()
      if (update.message && text === '/stats') {
        const s = await users.stats()
        await telegram.reply(
          update.message.chat.id,
          `users: ${s.users}\npaid orders: ${s.paid_orders}\nrevenue: $${(s.revenue_cents / 100).toFixed(2)}\ncredits spent: ${s.credits_spent}`,
        )
      }
      return { ok: true }
    })
  })

  await server.listen({ port: config.PORT, host: '0.0.0.0' })
  const address = server.addresses()[0]!
  return {
    server,
    config,
    gateway,
    assistant: assistantProvider,
    telegram,
    url: `http://localhost:${address.port}`,
    async close() {
      await server.close()
      await pool.end()
      if (redis) redis.disconnect()
    },
  }
}
