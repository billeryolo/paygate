import { describe, expect, it } from 'vitest'
import { CircuitBreaker, CircuitOpenError } from '../src/lib/circuit-breaker.js'
import { parseRetryAfter } from '../src/lib/http.js'
import { TokenBucket } from '../src/lib/rate-limiter.js'
import { backoffDelay, retry } from '../src/lib/retry.js'

describe('CircuitBreaker', () => {
  it('closed → open after threshold, half-open after reset, closed on success', async () => {
    let now = 0
    const transitions: string[] = []
    const cb = new CircuitBreaker({
      name: 't',
      failureThreshold: 3,
      resetMs: 1000,
      now: () => now,
      onStateChange: (a, b) => transitions.push(`${a}>${b}`),
    })
    const fail = () => cb.exec(async () => Promise.reject(new Error('x')))
    for (let i = 0; i < 3; i++) await expect(fail()).rejects.toThrow('x')
    expect(cb.currentState).toBe('open')
    await expect(cb.exec(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError)

    now = 1000
    expect(cb.currentState).toBe('half-open')
    expect(await cb.exec(async () => 'ok')).toBe('ok')
    expect(cb.currentState).toBe('closed')
    expect(transitions).toEqual(['closed>open', 'open>half-open', 'half-open>closed'])
  })

  it('a failed trial in half-open re-opens the circuit', async () => {
    let now = 0
    const cb = new CircuitBreaker({ name: 't', failureThreshold: 1, resetMs: 100, now: () => now })
    await expect(cb.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow()
    now = 100
    await expect(cb.exec(async () => Promise.reject(new Error('y')))).rejects.toThrow('y')
    expect(cb.currentState).toBe('open')
    now = 150
    await expect(cb.exec(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError)
  })

  it('isFailure decides what counts', async () => {
    const cb = new CircuitBreaker({
      name: 't',
      failureThreshold: 1,
      resetMs: 100,
      isFailure: () => false,
    })
    await expect(cb.exec(async () => Promise.reject(new Error('client bug')))).rejects.toThrow()
    expect(cb.currentState).toBe('closed')
  })
})

describe('TokenBucket', () => {
  it('allows a burst then refills over time', async () => {
    let now = 0
    const slept: number[] = []
    const bucket = new TokenBucket(
      2,
      1 / 1000,
      () => now,
      async (ms) => {
        slept.push(ms)
        now += ms
      },
    )
    await bucket.acquire()
    await bucket.acquire()
    expect(bucket.available).toBe(0)
    await bucket.acquire() // has to wait ~1s for one token
    expect(slept).toEqual([1000])
    await expect(bucket.acquire(500)).rejects.toThrow(/wait/)
  })
})

describe('retry', () => {
  it('uses full-jitter exponential backoff capped at maxMs', () => {
    expect(backoffDelay(0, 100, 10_000, () => 1)).toBe(100)
    expect(backoffDelay(3, 100, 10_000, () => 1)).toBe(800)
    expect(backoffDelay(10, 100, 1_000, () => 1)).toBe(1000)
    expect(backoffDelay(3, 100, 10_000, () => 0)).toBe(0)
  })

  it('stops on non-retryable errors and prefers Retry-After hints', async () => {
    const sleeps: number[] = []
    let calls = 0
    const result = await retry(
      async () => {
        calls++
        if (calls < 3) throw Object.assign(new Error('transient'), { hint: 750 })
        return 'done'
      },
      {
        attempts: 5,
        baseMs: 100,
        maxMs: 1000,
        shouldRetry: () => true,
        retryAfterMs: (e) => (e as { hint?: number }).hint,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      },
    )
    expect(result).toBe('done')
    expect(sleeps).toEqual([750, 750])

    await expect(
      retry(async () => Promise.reject(new Error('fatal')), {
        attempts: 5,
        baseMs: 1,
        maxMs: 1,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('fatal')
  })

  it('parses Retry-After in seconds or as an HTTP date', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter(null)).toBeUndefined()
    const future = new Date(Date.now() + 5000).toUTCString()
    const ms = parseRetryAfter(future)!
    expect(ms).toBeGreaterThan(3000)
    expect(ms).toBeLessThanOrEqual(5000)
  })
})
