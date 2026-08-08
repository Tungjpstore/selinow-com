PRAGMA foreign_keys = ON;

ALTER TABLE shop_customers ADD COLUMN anonymized_at TEXT;

CREATE TABLE buyer_privacy_requests (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'anonymize')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'blocked')),
  requested_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) BETWEEN 16 AND 128),
  projection_hash TEXT CHECK (projection_hash IS NULL OR length(projection_hash) BETWEEN 16 AND 128),
  safe_result_code TEXT NOT NULL CHECK (length(safe_result_code) BETWEEN 1 AND 64),
  retained_records_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(retained_records_json) AND json_type(retained_records_json) = 'object'
  ),
  request_id TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, requested_by_user_id, idempotency_key_hash),
  FOREIGN KEY (shop_id, customer_id) REFERENCES shop_customers(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_buyer_privacy_requests_shop_customer
  ON buyer_privacy_requests(shop_id, customer_id, created_at DESC, id);

DROP TRIGGER customer_notes_redaction_guard;
CREATE TRIGGER customer_notes_redaction_guard
BEFORE UPDATE ON customer_notes
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.customer_id != OLD.customer_id
  OR NEW.author_user_id != OLD.author_user_id
  OR (NEW.body != OLD.body AND NEW.body != '[redacted]')
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status = 'redacted'
  OR NEW.status != 'redacted'
  OR NEW.redacted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'customer_note_redaction_invalid');
END;
