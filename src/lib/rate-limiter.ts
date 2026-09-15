/**
 * Token bucket for *outbound* calls: keeps us under a provider's published limit instead of
 * discovering it through 429s. `acquire()` resolves when a token is available (callers queue
 * rather than fail), with an optional maximum wait so a pile-up turns into a clear error.
 */
export class RateLimitWaitError extends Error {
  constructor(public readonly waitMs: number) {
    super(`rate limiter: would need to wait ${waitMs}ms`)
    this.name = 'RateLimitWaitError'
  }
}

export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = capacity
    this.last = now()
  }

  /** `perMinute` requests, allowing bursts up to `burst`. */
  static perMinute(perMinute: number, burst = Math.max(1, Math.ceil(perMinute / 6))): TokenBucket {
    return new TokenBucket(burst, perMinute / 60_000)
  }

  private refill() {
    const t = this.now()
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs)
    this.last = t
  }

  get available(): number {
    this.refill()
    return Math.floor(this.tokens)
  }

  async acquire(maxWaitMs = 10_000): Promise<void> {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs)
    if (waitMs > maxWaitMs) throw new RateLimitWaitError(waitMs)
    await this.sleep(waitMs)
    this.refill()
    this.tokens = Math.max(0, this.tokens - 1)
  }
}
