/**
 * Circuit breaker (closed → open → half-open → closed).
 *
 * - closed: calls pass through; consecutive failures are counted.
 * - open: after `failureThreshold` consecutive failures, every call fails immediately with
 *   `CircuitOpenError` for `resetMs` — the failing dependency gets breathing room and our
 *   request threads aren't tied up waiting on timeouts.
 * - half-open: after the cooldown one trial call is allowed. Success closes the circuit;
 *   failure re-opens it for another `resetMs`.
 *
 * `isFailure` lets callers decide what counts: a 4xx from a validation mistake shouldn't
 * trip the breaker, a 5xx or a timeout should.
 */
export type CircuitState = 'closed' | 'open' | 'half-open'

export class CircuitOpenError extends Error {
  constructor(
    public readonly name_: string,
    public readonly retryAfterMs: number,
  ) {
    super(`circuit "${name_}" is open; retry in ${Math.ceil(retryAfterMs / 1000)}s`)
    this.name = 'CircuitOpenError'
  }
}

export interface BreakerOptions {
  name: string
  failureThreshold: number
  resetMs: number
  isFailure?: (err: unknown) => boolean
  onStateChange?: (from: CircuitState, to: CircuitState) => void
  now?: () => number
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failures = 0
  private openedAt = 0
  private trialInFlight = false
  private readonly now: () => number

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? Date.now
  }

  get currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.resetMs) {
      this.transition('half-open')
    }
    return this.state
  }

  get consecutiveFailures(): number {
    return this.failures
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState
    if (state === 'open') {
      throw new CircuitOpenError(this.opts.name, this.opts.resetMs - (this.now() - this.openedAt))
    }
    if (state === 'half-open') {
      if (this.trialInFlight) throw new CircuitOpenError(this.opts.name, this.opts.resetMs)
      this.trialInFlight = true
    }
    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      if (this.opts.isFailure?.(err) ?? true) this.onFailure()
      else this.onSuccess()
      throw err
    } finally {
      this.trialInFlight = false
    }
  }

  private onSuccess() {
    this.failures = 0
    if (this.state !== 'closed') this.transition('closed')
  }

  private onFailure() {
    this.failures += 1
    if (this.state === 'half-open' || this.failures >= this.opts.failureThreshold) {
      this.openedAt = this.now()
      this.transition('open')
    }
  }

  private transition(to: CircuitState) {
    const from = this.state
    if (from === to) return
    this.state = to
    this.opts.onStateChange?.(from, to)
  }

  /** For tests and admin endpoints. */
  reset() {
    this.failures = 0
    this.transition('closed')
  }
}
