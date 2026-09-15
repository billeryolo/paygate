import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url().default('postgresql://paygate:paygate@localhost:5432/paygate'),
  /** Optional: shared store for the inbound rate limiter across instances. */
  REDIS_URL: z.string().url().optional(),
  SENTRY_DSN: z.string().optional(),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  STRIPE_SECRET_KEY: z.string().default('sk_test_placeholder'),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_placeholder'),
  /** Seconds of clock skew tolerated when verifying webhook signatures. */
  STRIPE_WEBHOOK_TOLERANCE: z.coerce.number().int().positive().default(300),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  /** Client-side cap on OpenAI requests per minute (stay under the account limit). */
  OPENAI_RPM: z.coerce.number().int().positive().default(60),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_BASE_URL: z.string().url().default('https://api.telegram.org'),
  /** Shared secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token on inbound webhooks. */
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),

  /** Inbound API rate limit per API key. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  /** Circuit breaker tuning for outbound integrations. */
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  BREAKER_RESET_MS: z.coerce.number().int().positive().default(30_000),
  ASK_COST_CREDITS: z.coerce.number().int().positive().default(1),
})

export type Config = z.infer<typeof schema>

export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  const parsed = schema.safeParse({ ...process.env, ...overrides })
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  return parsed.data
}

/** Credit packs available for purchase. Prices in the smallest currency unit. */
export const PACKS = {
  small: { credits: 100, amountCents: 500, currency: 'usd' },
  medium: { credits: 500, amountCents: 2000, currency: 'usd' },
  large: { credits: 2000, amountCents: 6000, currency: 'usd' },
} as const
export type Pack = keyof typeof PACKS
