import type { Config } from '../config.js'
import { CircuitBreaker } from '../lib/circuit-breaker.js'
import { fetchWithPolicy, HttpError, type Policy } from '../lib/http.js'
import { TokenBucket } from '../lib/rate-limiter.js'

export interface Completion {
  answer: string
  model: string
  tokensUsed: number
}

export interface AssistantProvider {
  complete(question: string): Promise<Completion>
  readonly breaker: CircuitBreaker
}

export interface OpenAIOptions {
  baseUrl: string
  apiKey: string
  model: string
  rpm: number
  breakerThreshold: number
  breakerResetMs: number
  sleep?: Policy['sleep']
  log?: Policy['log']
  fetchImpl?: typeof fetch
}

export class OpenAIClient implements AssistantProvider {
  readonly breaker: CircuitBreaker
  private readonly policy: Policy

  constructor(private readonly opts: OpenAIOptions) {
    this.breaker = new CircuitBreaker({
      name: 'openai',
      failureThreshold: opts.breakerThreshold,
      resetMs: opts.breakerResetMs,
      // A 4xx (other than 429) is our mistake, not an outage: don't trip the breaker on it.
      isFailure: (err) => !(err instanceof HttpError) || err.retryable,
      onStateChange: (from, to) => opts.log?.('circuit state', { integration: 'openai', from, to }),
    })
    this.policy = {
      name: 'openai',
      breaker: this.breaker,
      limiter: TokenBucket.perMinute(opts.rpm),
      attempts: 3,
      timeoutMs: 30_000,
      sleep: opts.sleep,
      log: opts.log,
    }
  }

  static fromConfig(config: Config, extra: Partial<OpenAIOptions> = {}): OpenAIClient {
    return new OpenAIClient({
      baseUrl: config.OPENAI_BASE_URL,
      apiKey: config.OPENAI_API_KEY,
      model: config.OPENAI_MODEL,
      rpm: config.OPENAI_RPM,
      breakerThreshold: config.BREAKER_FAILURE_THRESHOLD,
      breakerResetMs: config.BREAKER_RESET_MS,
      ...extra,
    })
  }

  async complete(question: string): Promise<Completion> {
    const res = await fetchWithPolicy(
      this.policy,
      `${this.opts.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            { role: 'system', content: 'You are a concise, helpful assistant.' },
            { role: 'user', content: question },
          ],
          max_tokens: 400,
        }),
      },
      this.opts.fetchImpl,
    )
    const data = JSON.parse(res.body) as {
      model: string
      choices: { message: { content: string } }[]
      usage?: { total_tokens: number }
    }
    const answer = data.choices[0]?.message.content?.trim()
    if (!answer) throw new Error('openai returned no content')
    return { answer, model: data.model, tokensUsed: data.usage?.total_tokens ?? 0 }
  }
}
