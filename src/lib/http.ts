/**
 * `fetch` with the whole resilience stack applied, in this order:
 *
 *   rate limiter (don't exceed the provider's quota)
 *     → circuit breaker (fail fast while the provider is down)
 *       → retry with backoff (absorb transient 429/5xx/network errors, honour Retry-After)
 *         → fetch with a timeout
 *
 * The breaker wraps the retry loop, not the individual attempts, so one logical call that
 * exhausts its retries counts as one failure.
 */
import { CircuitBreaker } from './circuit-breaker.js'
import { TokenBucket } from './rate-limiter.js'
import { retry } from './retry.js'

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'HttpError'
  }
  get retryable() {
    return this.status === 429 || this.status === 408 || this.status >= 500
  }
}

export interface Policy {
  name: string
  breaker: CircuitBreaker
  limiter?: TokenBucket
  attempts?: number
  baseMs?: number
  maxMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string, fields: Record<string, unknown>) => void
  /** Extract a retry hint from a JSON body, e.g. Telegram's `parameters.retry_after`. */
  retryAfterFromBody?: (body: string) => number | undefined
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds)) return seconds * 1000
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.retryable
  // Network-level failures: DNS, connection reset, our own timeout abort.
  return err instanceof TypeError || (err as { name?: string })?.name === 'AbortError'
}

export async function fetchWithPolicy(
  policy: Policy,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: string; headers: Headers }> {
  if (policy.limiter) await policy.limiter.acquire()
  return policy.breaker.exec(() =>
    retry(
      async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), policy.timeoutMs ?? 15_000)
        try {
          const res = await fetchImpl(url, { ...init, signal: controller.signal })
          const body = await res.text()
          if (!res.ok) {
            const hint =
              parseRetryAfter(res.headers.get('retry-after')) ?? policy.retryAfterFromBody?.(body)
            throw new HttpError(res.status, body, hint)
          }
          return { status: res.status, body, headers: res.headers }
        } finally {
          clearTimeout(timer)
        }
      },
      {
        attempts: policy.attempts ?? 3,
        baseMs: policy.baseMs ?? 250,
        maxMs: policy.maxMs ?? 5_000,
        shouldRetry: isRetryable,
        retryAfterMs: (err) => (err instanceof HttpError ? err.retryAfterMs : undefined),
        sleep: policy.sleep,
        onRetry: (err, attempt, delayMs) =>
          policy.log?.('outbound retry', {
            integration: policy.name,
            attempt,
            delayMs,
            error: String(err),
          }),
      },
    ),
  )
}
