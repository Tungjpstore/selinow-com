PRAGMA foreign_keys = ON;

-- Initial subscription checkout reconciliation needs durable retry evidence.
-- Store only bounded operational state; provider payloads and hosted bearer
-- URLs remain outside D1.
ALTER TABLE billing_checkout_sessions ADD COLUMN reconciliation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0);
ALTER TABLE billing_checkout_sessions ADD COLUMN next_reconciliation_at TEXT;
ALTER TABLE billing_checkout_sessions ADD COLUMN last_reconciliation_at TEXT;
ALTER TABLE billing_checkout_sessions ADD COLUMN reconciliation_failure_code TEXT CHECK (
  reconciliation_failure_code IS NULL OR (
    length(reconciliation_failure_code) BETWEEN 3 AND 96
    AND reconciliation_failure_code NOT GLOB '*[^a-zA-Z0-9._:-]*'
  )
);

CREATE INDEX idx_billing_checkout_sessions_reconciliation
  ON billing_checkout_sessions(status, next_reconciliation_at, updated_at, id)
  WHERE status = 'open' AND provider_checkout_ref IS NOT NULL;

CREATE INDEX idx_billing_checkout_sessions_shop_reconciliation
  ON billing_checkout_sessions(shop_id, status, next_reconciliation_at, id)
  WHERE status = 'open' AND provider_checkout_ref IS NOT NULL;
