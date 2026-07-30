PRAGMA foreign_keys = ON;

CREATE TABLE payment_integrations (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  webhook_public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'payos'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'error', 'disconnected')),
  webhook_status TEXT NOT NULL CHECK (webhook_status IN ('pending', 'verified', 'error', 'disconnected')),
  active_credential_id TEXT,
  account_bin TEXT,
  account_number_masked TEXT,
  account_name_sanitized TEXT,
  last_safe_error_code TEXT,
  connected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, provider)
) STRICT;

CREATE INDEX idx_payment_integrations_shop_status
  ON payment_integrations(shop_id, status, id);

CREATE TABLE payment_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES payment_integrations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'payos'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'grace', 'revoked', 'error')),
  version INTEGER NOT NULL CHECK (version > 0),
  key_version TEXT NOT NULL,
  client_id_ciphertext_b64 TEXT NOT NULL,
  client_id_iv_b64 TEXT NOT NULL,
  api_key_ciphertext_b64 TEXT NOT NULL,
  api_key_iv_b64 TEXT NOT NULL,
  checksum_key_ciphertext_b64 TEXT NOT NULL,
  checksum_key_iv_b64 TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  activated_at TEXT,
  grace_ends_at TEXT,
  revoked_at TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (integration_id, version),
  UNIQUE (shop_id, provider, credential_fingerprint)
) STRICT;

CREATE UNIQUE INDEX idx_payment_credentials_active
  ON payment_credentials(integration_id) WHERE status = 'active';
CREATE INDEX idx_payment_credentials_shop_status
  ON payment_credentials(shop_id, status, created_at DESC, id);

CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  integration_id TEXT NOT NULL REFERENCES payment_integrations(id) ON DELETE RESTRICT,
  credential_id TEXT NOT NULL REFERENCES payment_credentials(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'payos'),
  provider_order_code INTEGER NOT NULL UNIQUE CHECK (provider_order_code > 0),
  provider_payment_link_id TEXT UNIQUE,
  provider_status TEXT,
  state TEXT NOT NULL CHECK (state IN ('creating', 'pending', 'paid_exact', 'partial', 'overpaid', 'late', 'identity_mismatch', 'inconsistent', 'terminal_unpaid', 'error')),
  expected_amount_minor INTEGER NOT NULL CHECK (expected_amount_minor > 0),
  currency TEXT NOT NULL,
  expected_description TEXT NOT NULL,
  checkout_url TEXT,
  qr_code TEXT,
  account_bin TEXT,
  account_number_masked TEXT,
  account_name_sanitized TEXT,
  provider_payload_hash TEXT,
  expires_at TEXT NOT NULL,
  last_reconciled_at TEXT,
  next_reconcile_at TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, order_id, provider)
) STRICT;

CREATE INDEX idx_payment_attempts_shop_order
  ON payment_attempts(shop_id, order_id, created_at DESC, id);
CREATE INDEX idx_payment_attempts_reconcile
  ON payment_attempts(state, next_reconcile_at, lease_expires_at, id);

CREATE TABLE payment_events (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  payment_attempt_id TEXT REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  integration_id TEXT NOT NULL REFERENCES payment_integrations(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'payos'),
  provider_event_reference TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature_verified INTEGER NOT NULL CHECK (signature_verified IN (0, 1)),
  normalized_state TEXT NOT NULL,
  process_result TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (integration_id, provider_event_reference, payload_hash)
) STRICT;

CREATE INDEX idx_payment_events_shop_received
  ON payment_events(shop_id, received_at DESC, id);
CREATE INDEX idx_payment_events_reference
  ON payment_events(integration_id, provider_event_reference, received_at DESC, id);

CREATE TABLE payment_exceptions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_attempt_id TEXT NOT NULL REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('partial', 'overpaid', 'late', 'identity_mismatch', 'inconsistent', 'manual_review')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'ignored')),
  safe_evidence_json TEXT NOT NULL CHECK (json_valid(safe_evidence_json)),
  resolution_reason TEXT,
  resolved_by_user_id TEXT REFERENCES platform_users(id) ON DELETE RESTRICT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_payment_exceptions_shop_status
  ON payment_exceptions(shop_id, status, created_at DESC, id);

CREATE TABLE fulfillments (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('digital_keys', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'fulfilled', 'failed', 'manual_review')),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fulfilled_at TEXT,
  failed_at TEXT,
  UNIQUE (shop_id, order_id, fulfillment_type),
  UNIQUE (idempotency_key)
) STRICT;

CREATE TABLE fulfillment_items (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  fulfillment_id TEXT NOT NULL REFERENCES fulfillments(id) ON DELETE CASCADE,
  order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  inventory_key_id TEXT NOT NULL REFERENCES inventory_keys(id) ON DELETE RESTRICT UNIQUE,
  delivered_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_fulfillment_items_shop_fulfillment
  ON fulfillment_items(shop_id, fulfillment_id, id);

CREATE TABLE outbox_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('order_paid', 'payment_exception')),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, kind, aggregate_type, aggregate_id)
) STRICT;

CREATE INDEX idx_outbox_jobs_ready
  ON outbox_jobs(status, next_attempt_at, lease_expires_at, id);
