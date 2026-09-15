import type { Config } from '../config.js'
import { CircuitBreaker } from '../lib/circuit-breaker.js'
import { fetchWithPolicy, HttpError, type Policy } from '../lib/http.js'
import { TokenBucket } from '../lib/rate-limiter.js'

export interface Notifier {
  notify(text: string): Promise<void>
  readonly breaker: CircuitBreaker
}

export interface TelegramOptions {
  baseUrl: string
  botToken: string
  chatId: string
  breakerThreshold: number
  breakerResetMs: number
  sleep?: Policy['sleep']
  log?: Policy['log']
  fetchImpl?: typeof fetch
}

/**
 * Telegram Bot API: 30 msg/s global, 1 msg/s per chat. On overflow it answers 429 with
 * `parameters.retry_after` (seconds) in the JSON body rather than a Retry-After header —
 * `retryAfterFromBody` teaches the generic policy to read it.
 */
export class TelegramNotifier implements Notifier {
  readonly breaker: CircuitBreaker
  private readonly policy: Policy

  constructor(private readonly opts: TelegramOptions) {
    this.breaker = new CircuitBreaker({
      name: 'telegram',
      failureThreshold: opts.breakerThreshold,
      resetMs: opts.breakerResetMs,
      isFailure: (err) => !(err instanceof HttpError) || err.retryable,
      onStateChange: (from, to) =>
        opts.log?.('circuit state', { integration: 'telegram', from, to }),
    })
    this.policy = {
      name: 'telegram',
      breaker: this.breaker,
      limiter: new TokenBucket(1, 1 / 1000), // 1 message/second to a single chat
      attempts: 4,
      timeoutMs: 10_000,
      sleep: opts.sleep,
      log: opts.log,
      retryAfterFromBody: (body) => {
        try {
          const parsed = JSON.parse(body) as { parameters?: { retry_after?: number } }
          const s = parsed.parameters?.retry_after
          return typeof s === 'number' ? s * 1000 : undefined
        } catch {
          return undefined
        }
      },
    }
  }

  static fromConfig(config: Config, extra: Partial<TelegramOptions> = {}): TelegramNotifier {
    return new TelegramNotifier({
      baseUrl: config.TELEGRAM_BASE_URL,
      botToken: config.TELEGRAM_BOT_TOKEN,
      chatId: config.TELEGRAM_CHAT_ID,
      breakerThreshold: config.BREAKER_FAILURE_THRESHOLD,
      breakerResetMs: config.BREAKER_RESET_MS,
      ...extra,
    })
  }

  get configured(): boolean {
    return Boolean(this.opts.botToken && this.opts.chatId)
  }

  async notify(text: string): Promise<void> {
    if (!this.configured) return
    await fetchWithPolicy(
      this.policy,
      `${this.opts.baseUrl}/bot${this.opts.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.opts.chatId, text, parse_mode: 'HTML' }),
      },
      this.opts.fetchImpl,
    )
  }

  /** Reply to an inbound update (bot command). */
  async reply(chatId: string | number, text: string): Promise<void> {
    if (!this.opts.botToken) return
    await fetchWithPolicy(
      this.policy,
      `${this.opts.baseUrl}/bot${this.opts.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
      this.opts.fetchImpl,
    )
  }
}
