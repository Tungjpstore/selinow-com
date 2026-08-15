PRAGMA foreign_keys = ON;

ALTER TABLE auth_request_admissions
  ADD COLUMN subject_hash TEXT CHECK (subject_hash IS NULL OR length(subject_hash) BETWEEN 16 AND 128);
ALTER TABLE auth_request_admissions
  ADD COLUMN delivery_permitted INTEGER NOT NULL DEFAULT 1 CHECK (delivery_permitted IN (0, 1));
CREATE INDEX idx_auth_request_admissions_subject_window
  ON auth_request_admissions(action, subject_hash, window_started_at, id)
  WHERE subject_hash IS NOT NULL;
