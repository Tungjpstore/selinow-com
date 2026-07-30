PRAGMA foreign_keys = ON;

ALTER TABLE payment_attempts ADD COLUMN paid_event_id TEXT REFERENCES payment_events(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_payment_attempts_paid_event
  ON payment_attempts(paid_event_id)
  WHERE paid_event_id IS NOT NULL;
