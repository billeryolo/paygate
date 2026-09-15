import Stripe from 'stripe'

export interface CheckoutRequest {
  orderId: string
  userId: string
  credits: number
  amountCents: number
  currency: string
  successUrl: string
  cancelUrl: string
  /** Forwarded to Stripe as its own idempotency key: a retried request creates one session. */
  idempotencyKey: string
}

export interface PaymentGateway {
  createCheckoutSession(req: CheckoutRequest): Promise<{ sessionId: string; url: string }>
  /** Throws on a bad signature or a stale timestamp. */
  parseWebhook(rawBody: Buffer | string, signature: string): Stripe.Event
}

export class StripeGateway implements PaymentGateway {
  private readonly stripe: Stripe

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    private readonly toleranceSeconds: number,
  ) {
    this.stripe = new Stripe(secretKey, {
      apiVersion: '2024-06-20',
      maxNetworkRetries: 2,
      timeout: 15_000,
    })
  }

  async createCheckoutSession(req: CheckoutRequest) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: req.orderId,
        metadata: { orderId: req.orderId, userId: req.userId, credits: String(req.credits) },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: req.currency,
              unit_amount: req.amountCents,
              product_data: { name: `${req.credits} credits` },
            },
          },
        ],
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
      },
      { idempotencyKey: req.idempotencyKey },
    )
    if (!session.url) throw new Error('stripe returned a session without a url')
    return { sessionId: session.id, url: session.url }
  }

  parseWebhook(rawBody: Buffer | string, signature: string): Stripe.Event {
    // constructEvent recomputes HMAC-SHA256 over `${timestamp}.${rawBody}` with the endpoint
    // secret and compares in constant time; it also rejects timestamps outside the tolerance
    // window, which blocks replay of a captured payload.
    return this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
      this.toleranceSeconds,
    )
  }
}

/**
 * Test double: no network, but signature verification is the real thing — tests sign
 * payloads with `Stripe.webhooks.generateTestHeaderString` and this verifies them.
 */
export class FakeStripeGateway implements PaymentGateway {
  public sessions: CheckoutRequest[] = []
  private readonly stripe = new Stripe('sk_test_fake', { apiVersion: '2024-06-20' })

  constructor(private readonly webhookSecret: string) {}

  async createCheckoutSession(req: CheckoutRequest) {
    this.sessions.push(req)
    const sessionId = `cs_test_${req.orderId.replace(/-/g, '').slice(0, 24)}`
    return { sessionId, url: `https://checkout.stripe.test/pay/${sessionId}` }
  }

  parseWebhook(rawBody: Buffer | string, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret, 300)
  }

  sign(payload: string): string {
    return this.stripe.webhooks.generateTestHeaderString({ payload, secret: this.webhookSecret })
  }
}
