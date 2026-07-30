PRAGMA foreign_keys = ON;

ALTER TABLE payment_events ADD COLUMN processing_token TEXT;
ALTER TABLE payment_events ADD COLUMN processing_started_at TEXT;

CREATE INDEX idx_payment_events_processing_claim
  ON payment_events(process_result, processing_started_at, id)
  WHERE processed_at IS NULL;
