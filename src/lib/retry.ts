/**
 * Retry with full-jitter exponential backoff. The `retryAfterMs` hint (from a 429/503
 * `Retry-After` header or Telegram's `retry_after`) overrides the computed delay: when the
 * server tells you when to come back, listen.
 */
export interface RetryOptions {
  attempts: number
  baseMs: number
  maxMs: number
  shouldRetry: (err: unknown) => boolean
  retryAfterMs?: (err: unknown) => number | undefined
  sleep?: (ms: number) => Promise<void>
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random = Math.random,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt)
  return Math.floor(random() * cap)
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep
  let lastErr: unknown
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === opts.attempts - 1 || !opts.shouldRetry(err)) throw err
      const hinted = opts.retryAfterMs?.(err)
      const delay = hinted ?? backoffDelay(attempt, opts.baseMs, opts.maxMs)
      opts.onRetry?.(err, attempt + 1, delay)
      await sleep(delay)
    }
  }
  throw lastErr
}
