# Paygate — credits, Stripe, and an AI assistant that fails gracefully

Node 22 · TypeScript · Fastify · PostgreSQL 16 · Stripe Checkout + Webhooks · OpenAI API · Telegram Bot API · Redis (rate limiting) · Docker Compose · GitHub Actions

A small commercial product: users buy credit packs through Stripe Checkout, Stripe tells us
they paid via a signed webhook, credits land in a ledger, and users spend them asking an
OpenAI-backed assistant. Ops get a Telegram message per sale and can ask the bot for `/stats`.

What it is really about is the integration engineering:

- **Webhook security** — Stripe signatures are verified (HMAC-SHA256 with timestamp tolerance
  against replays); Telegram inbound updates are gated by the shared secret header.
- **Idempotency everywhere money moves** — client `Idempotency-Key` on checkout (stored
  request hash + response), Stripe's own idempotency key on session creation, event-id
  primary key on webhooks, `FOR UPDATE` on the order, and a unique ledger reference. A
  double-delivered webhook cannot credit twice; a double-clicked checkout cannot charge twice.
- **Circuit breaker + retry with backoff + rate limiting** around every outbound call
  (OpenAI, Telegram), with `Retry-After` / `retry_after` honoured, and non-retryable client
  errors kept from tripping the breaker.
- **Charge after success** — credits are deducted only once the assistant answered, inside a
  row-locked transaction, so an outage never burns a user's balance.

```
docker compose up --build
```

| URL                                  | What                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| http://localhost:3000/health         | status + circuit breaker states                                               |
| http://localhost:3000/packs          | purchasable packs                                                             |
| `docker compose --profile stripe up` | also runs `stripe-cli listen` forwarding test events (needs `STRIPE_API_KEY`) |

Without real keys the app runs with a **fake Stripe gateway** (no network, but webhook
signature verification is the real Stripe implementation) and the OpenAI/Telegram calls simply
fail closed. The test-suite exercises everything through fake upstream HTTP servers.

### Try it

```bash
# 1. get an API key
curl -s localhost:3000/users -H 'content-type: application/json' -d '{"email":"me@example.com"}'
# 2. start a checkout (idempotent — send the same key twice and you get the same order back)
curl -s localhost:3000/checkout -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
     -H 'idempotency-key: 9f1c0f2e-any-uuid' -d '{"pack":"small"}'
# 3. (with stripe-cli) pay in the browser at checkoutUrl; the webhook credits 100 credits
# 4. spend them
curl -s localhost:3000/ask -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
     -d '{"question":"Explain idempotency in one sentence"}'
curl -s localhost:3000/me -H "authorization: Bearer $KEY"      # balance + ledger
```

## Live on Railway

**https://paygate-production-ee1e.up.railway.app** — [`/health`](https://paygate-production-ee1e.up.railway.app/health) · [`/packs`](https://paygate-production-ee1e.up.railway.app/packs).
Runs with the fake Stripe gateway (no real keys) on Railway managed Postgres/Redis; the
"Try it" flow above works against it (checkout returns a fake session URL; the webhook
endpoint verifies real Stripe signatures against `STRIPE_WEBHOOK_SECRET`).

---

## Architecture

```
 client ──▶ Fastify ──▶ services/billing ──▶ Stripe API (create Checkout Session, idempotency key)
                │              ▲
                │              └── POST /webhooks/stripe  ◀── Stripe (signed events)
                │                     verify → insert event (PK) → BEGIN → lock order → ledger → COMMIT
                │                     └─ after commit: Telegram notify (breaker + retry + 1 msg/s)
                └──▶ services/assistant ──▶ OpenAI  (token bucket → breaker → retry(backoff, Retry-After) → fetch+timeout)
                          └─ on success: BEGIN → lock balance → completions + ledger(-cost) → COMMIT
```

```
src/
  app.ts                  Fastify wiring: auth, per-key rate limit (Redis-backed if REDIS_URL), error mapping, routes
  config.ts               zod-validated env + credit PACKS
  lib/circuit-breaker.ts  closed → open → half-open state machine, pluggable failure predicate
  lib/retry.ts            full-jitter exponential backoff; Retry-After hints win over the formula
  lib/rate-limiter.ts     token bucket for outbound quotas
  lib/http.ts             fetchWithPolicy = limiter → breaker → retry → fetch(timeout)
  integrations/stripe.ts  PaymentGateway: real (stripe SDK) + fake (real signature verification)
  integrations/openai.ts  chat completions through the policy stack
  integrations/telegram.ts sendMessage through the policy stack; reads `parameters.retry_after`
  services/billing.ts     idempotent checkout, idempotent webhook processing, ledger credit
  services/assistant.ts   charge-after-success with row lock
  services/users.ts       API keys (sha256 stored), ledger, stats
  db/migrate.ts           forward-only SQL migrator with advisory lock
migrations/001_init.sql
test/                     vitest: 23 tests against real Postgres + scripted fake upstreams
```

### Webhook verification

`POST /webhooks/stripe` is registered in a scope whose JSON parser keeps the **raw body**;
`stripe.webhooks.constructEvent(rawBody, signature, secret, tolerance)` recomputes
`HMAC-SHA256(timestamp + "." + body)` and compares in constant time, and rejects timestamps
older than `STRIPE_WEBHOOK_TOLERANCE` (300 s) so a captured payload can't be replayed later.
Tests cover: missing header, wrong secret, stale timestamp, tampered body with a valid
signature for the original — all `400`, balance untouched.

`POST /webhooks/telegram` compares `X-Telegram-Bot-Api-Secret-Token` with the secret passed to
`setWebhook`; anything else is `401`.

### Idempotent payment processing

Layers, in the order they trigger (`services/billing.ts::handleWebhookEvent`):

1. `INSERT INTO webhook_events (id = event.id) … ON CONFLICT DO NOTHING`. A redelivery of a
   processed event returns `duplicate` immediately. An event that was inserted but whose
   processing crashed has `processed_at IS NULL` and is processed again on Stripe's retry.
2. Inside a transaction, `SELECT … FOR UPDATE` on the event row serialises two deliveries of
   the same event arriving at the same instant (the test fires them in parallel).
3. `SELECT … FOR UPDATE OF orders` and a status check: a _different_ event for the same order
   (Stripe sends more than one "completed"-like event) finds `status = 'paid'` and does nothing.
4. `ledger_entries (ref_type, ref_id)` is `UNIQUE` — even a code path that forgot the checks
   would fail the insert and roll back.
5. `processed_at` is set in the same transaction as the credit; side effects (Telegram) run
   only after `COMMIT` and never block the `200` to Stripe.

The credit amount comes from **our** `orders` row, never from the webhook payload.

### Idempotent checkout (client side)

`POST /checkout` requires an `Idempotency-Key`. The key is reserved in `idempotency_keys`
(PK `(user_id, key)`) with a hash of the request body before any work happens:

| Situation                                 | Response                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| first request                             | `201`, order + Stripe session created, response stored                             |
| same key, same body                       | `201` with the stored response, header `Idempotent-Replayed: true`, no new session |
| same key, different body                  | `422 idempotency_conflict`                                                         |
| same key while the first is still running | `409 idempotency_in_flight`                                                        |

The Stripe session is created with `{ idempotencyKey }` too, so even a crash between "session
created" and "response stored" cannot produce two sessions on retry.

### Circuit breaker, retries, rate limits

`lib/http.ts::fetchWithPolicy` composes the stack for every outbound call:

```
limiter.acquire()             # token bucket: OPENAI_RPM/min, Telegram 1 msg/s per chat
  breaker.exec(               # open after BREAKER_FAILURE_THRESHOLD consecutive failed *calls*
    retry(                    # 3–4 attempts, full-jitter backoff 250 ms → 5 s
      fetch + AbortController timeout
```

- `Retry-After` (seconds or HTTP-date) and Telegram's JSON `parameters.retry_after` override
  the computed delay — when the provider says when to come back, we listen.
- Only 429/408/5xx/network/timeouts are retried and count as breaker failures; a 4xx is our
  bug and neither retries nor trips the circuit (`test: a client error (4xx) is not retried`).
- While the circuit is open, `/ask` returns `503` with `Retry-After` **without** calling
  upstream and **without** charging credits. After `BREAKER_RESET_MS` one trial call is let
  through (half-open); success closes the circuit. `/health` exposes both circuits' state.
- Inbound: `@fastify/rate-limit` per API key (`RATE_LIMIT_MAX` per window), backed by Redis
  when `REDIS_URL` is set so the limit holds across instances.

### Credits and the ledger

`ledger_entries` is append-only; `users.balance` is a maintained aggregate with
`CHECK (balance >= 0)`. `/ask` checks the balance, calls the assistant, then in one
transaction locks the user row, re-checks, inserts the `completions` audit row and a `-cost`
ledger entry, and decrements the balance. Three concurrent asks on one account end at
`balance − 3`, never lower.

### Observability

Fastify's pino JSON logging with `reqId` (honours `X-Request-ID`, echoed back), sensitive
headers redacted (`authorization`, `stripe-signature`). Circuit transitions and every outbound
retry are logged with the integration name. `SENTRY_DSN` enables `@sentry/node` with the
Fastify error handler.

---

## Database schema

```
users ──< orders          ──▶ stripe_session_id (unique)
users ──< ledger_entries  UNIQUE (ref_type, ref_id)
users ──< completions
users ──< idempotency_keys  PK (user_id, key)
webhook_events            PK = Stripe event id, processed_at, error
```

## API

| Method | Path                 | Auth                    | Notes                                                                                                 |
| ------ | -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| POST   | `/users`             | –                       | `{email}` → `{user, apiKey}` (key shown once)                                                         |
| GET    | `/packs`             | –                       | credit packs                                                                                          |
| GET    | `/me`                | key                     | balance + last 50 ledger entries                                                                      |
| POST   | `/checkout`          | key + `Idempotency-Key` | `{pack}` → `{order, checkoutUrl}`                                                                     |
| GET    | `/orders/:id`        | key                     | order status                                                                                          |
| POST   | `/ask`               | key                     | `{question}` → `{answer, cost, balance}`; `402` no credits, `503` circuit open, `502` upstream failed |
| POST   | `/webhooks/stripe`   | signature               | `{received, outcome: processed \| duplicate \| ignored}`                                              |
| POST   | `/webhooks/telegram` | secret header           | `/stats` command                                                                                      |
| GET    | `/health`            | –                       | Postgres + circuit states                                                                             |

## Tests

```bash
TEST_DATABASE_URL=postgresql://paygate:paygate@localhost:5432/paygate_test npm test
```

23 tests. OpenAI and Telegram are **real HTTP servers** started in-process with scripted
responses, so the real client code, `Retry-After` parsing and timeout handling are exercised;
Stripe is the fake gateway with the SDK's real signature verification and
`generateTestHeaderString` for signing. Sleep is injected so backoff tests assert exact delays
(`3000` for `Retry-After: 3`) without waiting.

Covered: API keys, per-key rate limit, idempotent checkout (replay / conflict / race), webhook
signature rejection (missing / forged / stale / tampered), single credit across redelivery,
duplicate events and parallel delivery, Telegram notification with `retry_after`, `/stats`
command, `/ask` with no credits, atomic charge, concurrent asks, retry-then-succeed, circuit
open → fail fast → recover, 4xx not retried, plus unit tests for the breaker state machine,
token bucket, backoff and `Retry-After` parsing.

## CI

eslint → prettier → tsc → vitest (Postgres + Redis services) → `docker compose build`.

## Going live

1. `STRIPE_SECRET_KEY=sk_test_…`, create a webhook endpoint for `checkout.session.completed`
   and `checkout.session.expired` pointing at `/webhooks/stripe`, set `STRIPE_WEBHOOK_SECRET`.
2. `OPENAI_API_KEY`, optionally `OPENAI_RPM` below your account's limit.
3. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; for `/stats`, call `setWebhook` with
   `secret_token = TELEGRAM_WEBHOOK_SECRET` and `url = PUBLIC_URL/webhooks/telegram`.
