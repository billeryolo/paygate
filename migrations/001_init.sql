-- Paygate: credits ledger + Stripe billing

CREATE TABLE users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email        varchar(255) NOT NULL UNIQUE,
    api_key_hash char(64) NOT NULL UNIQUE,          -- sha256 of the bearer key; the key itself is shown once
    balance      integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per purchase attempt. `stripe_session_id` is filled once Stripe accepts the session.
CREATE TABLE orders (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    pack              varchar(16) NOT NULL,
    credits           integer NOT NULL CHECK (credits > 0),
    amount_cents      integer NOT NULL CHECK (amount_cents > 0),
    currency          char(3) NOT NULL,
    status            varchar(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'expired')),
    stripe_session_id varchar(255) UNIQUE,
    paid_at           timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_orders_user_created ON orders (user_id, created_at DESC);

-- Append-only money/credits movements. The (ref_type, ref_id) uniqueness is the second line of
-- defence against double-crediting: even if the webhook handler is somehow run twice for the
-- same order, the second INSERT fails and the transaction rolls back.
CREATE TABLE ledger_entries (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    delta      integer NOT NULL CHECK (delta <> 0),
    reason     varchar(32) NOT NULL,               -- purchase | ask | refund | adjustment
    ref_type   varchar(32) NOT NULL,               -- order | completion | manual
    ref_id     varchar(255) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ref_type, ref_id)
);
CREATE INDEX ix_ledger_user_created ON ledger_entries (user_id, created_at DESC);

-- Every webhook event Stripe ever delivered. PK = Stripe's event id, so a redelivery is a
-- primary-key conflict rather than a second charge. processed_at stays NULL until the handler
-- commits, which lets a failed attempt be retried safely.
CREATE TABLE webhook_events (
    id           varchar(255) PRIMARY KEY,
    provider     varchar(16) NOT NULL,
    type         varchar(100) NOT NULL,
    payload      jsonb NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    error        text
);
CREATE INDEX ix_webhook_events_unprocessed ON webhook_events (received_at) WHERE processed_at IS NULL;

-- Client-supplied Idempotency-Key for POST /checkout: same key + same request → same
-- response; same key + different request → 422. Rows expire after 24 h (see cleanup).
CREATE TABLE idempotency_keys (
    key          varchar(128) NOT NULL,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    request_hash char(64) NOT NULL,
    status_code  integer,
    response     jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

-- Assistant usage, for auditing what credits bought.
CREATE TABLE completions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    question    text NOT NULL,
    answer      text NOT NULL,
    model       varchar(64) NOT NULL,
    tokens_used integer NOT NULL DEFAULT 0,
    cost        integer NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
