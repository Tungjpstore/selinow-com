PRAGMA foreign_keys = ON;

CREATE TABLE data_export_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('standard', 'inventory_keys_plaintext')),
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'available', 'downloaded', 'expired', 'failed', 'canceled')
  ),
  requested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  object_etag TEXT,
  ciphertext_sha256 TEXT,
  ciphertext_size_bytes INTEGER CHECK (
    ciphertext_size_bytes IS NULL OR ciphertext_size_bytes >= 0
  ),
  encryption_key_version TEXT NOT NULL,
  encryption_iv_b64 TEXT,
  download_token_hash TEXT,
  download_token_expires_at TEXT,
  download_token_consumed_at TEXT,
  includes_plaintext_keys INTEGER NOT NULL DEFAULT 0 CHECK (includes_plaintext_keys IN (0, 1)),
  retention_class TEXT NOT NULL CHECK (retention_class IN ('standard', 'high_risk')),
  retain_until TEXT NOT NULL,
  object_deleted_at TEXT,
  last_safe_error_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'standard' AND includes_plaintext_keys = 0 AND retention_class = 'standard')
    OR (
      kind = 'inventory_keys_plaintext'
      AND includes_plaintext_keys = 1
      AND retention_class = 'high_risk'
    )
  ),
  CHECK (
    status NOT IN ('available', 'downloaded')
    OR (
      object_etag IS NOT NULL
      AND ciphertext_sha256 IS NOT NULL
      AND ciphertext_size_bytes IS NOT NULL
      AND encryption_iv_b64 IS NOT NULL
      AND download_token_hash IS NOT NULL
      AND download_token_expires_at IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  CHECK (download_token_consumed_at IS NULL OR status = 'downloaded')
) STRICT;

CREATE UNIQUE INDEX idx_data_export_jobs_shop_active_kind
  ON data_export_jobs(shop_id, kind)
  WHERE status IN ('processing', 'available');

CREATE INDEX idx_data_export_jobs_shop_status_created
  ON data_export_jobs(shop_id, status, created_at DESC, id);

CREATE INDEX idx_data_export_jobs_shop_download
  ON data_export_jobs(shop_id, id, status, download_token_expires_at)
  WHERE download_token_hash IS NOT NULL AND download_token_consumed_at IS NULL;

CREATE INDEX idx_data_export_jobs_retention
  ON data_export_jobs(status, retain_until, id)
  WHERE object_deleted_at IS NULL;

CREATE TABLE shop_deletion_requests (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'blocked', 'retention_hold', 'failed', 'completed', 'canceled')
  ),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  requested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  grace_ends_at TEXT NOT NULL,
  financial_records_retain_until TEXT NOT NULL,
  legal_hold_until TEXT,
  checkout_blocked_at TEXT NOT NULL,
  routing_removed_at TEXT NOT NULL,
  provider_cleanup_completed_at TEXT,
  secret_material_destroyed_at TEXT,
  secret_material_destroyed_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(secret_material_destroyed_json)
    AND json_type(secret_material_destroyed_json) = 'object'
  ),
  completed_at TEXT,
  last_safe_error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (grace_ends_at >= created_at),
  CHECK (financial_records_retain_until >= created_at),
  CHECK (completed_at IS NULL OR status = 'completed'),
  CHECK (secret_material_destroyed_at IS NULL OR provider_cleanup_completed_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX idx_shop_deletion_requests_shop_active
  ON shop_deletion_requests(shop_id)
  WHERE status IN ('processing', 'blocked', 'retention_hold', 'failed');

CREATE INDEX idx_shop_deletion_requests_shop_status
  ON shop_deletion_requests(shop_id, status, updated_at DESC, id);

CREATE INDEX idx_shop_deletion_requests_resume
  ON shop_deletion_requests(status, grace_ends_at, updated_at, id)
  WHERE status IN ('processing', 'blocked', 'retention_hold', 'failed');

CREATE INDEX idx_shop_deletion_requests_financial_retention
  ON shop_deletion_requests(financial_records_retain_until, status, id);

CREATE TRIGGER orders_block_inactive_or_deleting_shop
BEFORE INSERT ON orders
WHEN EXISTS (
  SELECT 1
  FROM shops
  WHERE shops.id = NEW.shop_id
    AND (
      shops.status != 'active'
      OR EXISTS (
        SELECT 1
        FROM shop_deletion_requests
        WHERE shop_deletion_requests.shop_id = shops.id
          AND shop_deletion_requests.status IN ('processing', 'blocked', 'retention_hold', 'failed')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'shop_checkout_blocked');
END;

CREATE TABLE shop_deletion_steps (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL REFERENCES shop_deletion_requests(id) ON DELETE RESTRICT,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  step_code TEXT NOT NULL CHECK (
    step_code IN (
      'checkout_block', 'routing_remove', 'active_payment_drain', 'grace_wait',
      'custom_domain_cleanup', 'telegram_cleanup', 'payment_cleanup',
      'crypto_shred', 'finalize'
    )
  ),
  sequence_no INTEGER NOT NULL CHECK (sequence_no BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'blocked', 'completed', 'failed', 'skipped')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (request_id, step_code),
  UNIQUE (request_id, sequence_no),
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status != 'processing'
  ),
  CHECK (completed_at IS NULL OR status IN ('completed', 'skipped'))
) STRICT;

CREATE INDEX idx_shop_deletion_steps_shop_status
  ON shop_deletion_steps(shop_id, status, sequence_no, updated_at, id);

CREATE INDEX idx_shop_deletion_steps_request_sequence
  ON shop_deletion_steps(request_id, sequence_no, status, id);

CREATE INDEX idx_shop_deletion_steps_leases
  ON shop_deletion_steps(status, lease_expires_at, id)
  WHERE status = 'processing';

CREATE TABLE abuse_reports (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('shop', 'product', 'domain', 'order', 'other')),
  target_ref TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('copyright', 'fraud', 'malware', 'prohibited_content', 'privacy', 'other')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('received', 'triaged', 'investigating', 'actioned', 'dismissed', 'closed')
  ),
  reporter_contact_hash TEXT,
  summary_sanitized TEXT NOT NULL CHECK (length(summary_sanitized) BETWEEN 1 AND 2000),
  evidence_reference TEXT,
  retention_class TEXT NOT NULL DEFAULT 'legal' CHECK (retention_class IN ('standard', 'security', 'legal')),
  retain_until TEXT NOT NULL,
  assigned_admin_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  last_safe_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (reporter_contact_hash IS NULL OR length(reporter_contact_hash) BETWEEN 16 AND 128)
) STRICT;

CREATE INDEX idx_abuse_reports_shop_status
  ON abuse_reports(shop_id, status, created_at DESC, id);

CREATE INDEX idx_abuse_reports_status_created
  ON abuse_reports(status, created_at, id);

CREATE INDEX idx_abuse_reports_retention
  ON abuse_reports(retention_class, retain_until, id);

CREATE TABLE moderation_actions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  abuse_report_id TEXT REFERENCES abuse_reports(id) ON DELETE SET NULL,
  action_kind TEXT NOT NULL CHECK (
    action_kind IN (
      'shop_suspend', 'shop_restore', 'product_suspend', 'product_restore',
      'domain_suspend', 'evidence_preserve', 'legal_hold_set', 'legal_hold_release'
    )
  ),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('shop', 'product', 'domain', 'deletion_request')),
  target_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'reversed')),
  safe_reason_code TEXT NOT NULL CHECK (length(safe_reason_code) BETWEEN 1 AND 64),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(safe_metadata_json) AND json_type(safe_metadata_json) = 'object'
  ),
  actor_admin_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  retention_class TEXT NOT NULL DEFAULT 'legal' CHECK (retention_class IN ('security', 'legal')),
  retain_until TEXT NOT NULL,
  applied_at TEXT,
  reversed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_moderation_actions_shop_status
  ON moderation_actions(shop_id, status, created_at DESC, id);

CREATE INDEX idx_moderation_actions_report
  ON moderation_actions(abuse_report_id, created_at DESC, id)
  WHERE abuse_report_id IS NOT NULL;

CREATE INDEX idx_moderation_actions_target
  ON moderation_actions(target_kind, target_ref, created_at DESC, id);

CREATE INDEX idx_moderation_actions_retention
  ON moderation_actions(retention_class, retain_until, id);
