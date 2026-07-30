PRAGMA foreign_keys = ON;

ALTER TABLE audit_logs
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'application' CHECK (
    source_kind IN ('application', 'http', 'queue', 'scheduled', 'migration')
  );

ALTER TABLE audit_logs
  ADD COLUMN correlation_id TEXT;

ALTER TABLE audit_logs
  ADD COLUMN operation_id TEXT;

ALTER TABLE audit_logs
  ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1 CHECK (metadata_version > 0);

ALTER TABLE audit_logs
  ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'standard' CHECK (
    retention_class IN ('standard', 'security', 'financial', 'legal')
  );

CREATE TRIGGER audit_logs_immutable_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs_immutable');
END;

CREATE TRIGGER audit_logs_immutable_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs_immutable');
END;

CREATE TABLE operations_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  scope_key TEXT NOT NULL,
  incident_key TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'queue_dead_letter', 'outbox_failure', 'provider_degraded', 'security_limit',
    'encryption_rotation', 'backup_failure', 'restore_failure', 'system_health'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'queue', 'outbox', 'payment', 'telegram', 'domain', 'security',
    'encryption', 'backup', 'restore', 'system'
  )),
  source_ref TEXT NOT NULL,
  safe_context_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(safe_context_json) AND json_type(safe_context_json) = 'object'
  ),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  acknowledged_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  acknowledged_at TEXT,
  resolved_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  resolution_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'open' AND acknowledged_at IS NULL AND resolved_at IS NULL)
    OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_operations_incidents_active_dedupe
  ON operations_incidents(scope_key, incident_key)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX idx_operations_incidents_shop_status
  ON operations_incidents(shop_id, status, severity, last_seen_at DESC, id);

CREATE INDEX idx_operations_incidents_source
  ON operations_incidents(source_kind, source_ref, last_seen_at DESC, id);

CREATE TABLE queue_dead_letters (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  scope_key TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (message_kind IN (
    'order_paid', 'payment_exception', 'integration', 'notification',
    'telegram_delivery', 'domain_reconciliation', 'operations', 'unknown'
  )),
  reference_type TEXT NOT NULL CHECK (reference_type IN (
    'order', 'payment_attempt', 'payment_integration', 'telegram_integration',
    'shop_domain', 'outbox_job', 'rotation_run', 'backup_snapshot', 'none'
  )),
  reference_id TEXT,
  failure_code TEXT NOT NULL,
  safe_envelope_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(safe_envelope_json) AND json_type(safe_envelope_json) = 'object'
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'retry_requested', 'resolved')),
  provider_attempts INTEGER NOT NULL DEFAULT 0 CHECK (provider_attempts >= 0),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  incident_id TEXT REFERENCES operations_incidents(id) ON DELETE SET NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  acknowledged_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  acknowledged_at TEXT,
  retry_requested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  retry_requested_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  resolved_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  resolution_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (queue_name, message_id),
  CHECK (reference_type = 'none' OR reference_id IS NOT NULL),
  CHECK (
    (status = 'open' AND acknowledged_at IS NULL AND retry_requested_at IS NULL AND resolved_at IS NULL)
    OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND retry_requested_at IS NULL AND resolved_at IS NULL)
    OR (status = 'retry_requested' AND retry_requested_at IS NOT NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_queue_dead_letters_shop_status
  ON queue_dead_letters(shop_id, status, last_seen_at DESC, id);

CREATE INDEX idx_queue_dead_letters_shop_queue
  ON queue_dead_letters(shop_id, queue_name, last_seen_at DESC, id);

CREATE INDEX idx_queue_dead_letters_incident
  ON queue_dead_letters(incident_id, status, id)
  WHERE incident_id IS NOT NULL;

CREATE TABLE encryption_rotation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  scope_key TEXT NOT NULL,
  key_family TEXT NOT NULL CHECK (key_family IN (
    'inventory', 'payment_credentials', 'telegram_credentials', 'telegram_recipient_ids'
  )),
  source_key_version TEXT NOT NULL,
  target_key_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'planned', 'running', 'paused', 'completed', 'failed', 'canceled'
  )),
  dry_run INTEGER NOT NULL DEFAULT 1 CHECK (dry_run IN (0, 1)),
  total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
  failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  requested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_key_version <> target_key_version),
  CHECK (processed_items + failed_items <= total_items)
) STRICT;

CREATE UNIQUE INDEX idx_encryption_rotation_runs_active
  ON encryption_rotation_runs(scope_key, key_family, target_key_version)
  WHERE status IN ('planned', 'running', 'paused');

CREATE INDEX idx_encryption_rotation_runs_shop_status
  ON encryption_rotation_runs(shop_id, status, updated_at DESC, id);

CREATE TABLE encryption_rotation_items (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES encryption_rotation_runs(id) ON DELETE RESTRICT,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'inventory_key', 'payment_credential', 'telegram_credential', 'telegram_recipient'
  )),
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  source_key_version TEXT NOT NULL,
  target_key_version TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  processed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, resource_type, resource_id),
  CHECK (source_key_version <> target_key_version)
) STRICT;

CREATE INDEX idx_encryption_rotation_items_shop_status
  ON encryption_rotation_items(shop_id, status, updated_at, id);

CREATE INDEX idx_encryption_rotation_items_run_status
  ON encryption_rotation_items(run_id, status, updated_at, id);

CREATE TABLE security_rate_limits (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  window_ends_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  blocked_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
  blocked_until TEXT,
  last_safe_reason_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key, action, subject_hash, window_started_at),
  CHECK (length(subject_hash) BETWEEN 16 AND 128),
  CHECK (window_ends_at > window_started_at)
) STRICT;

CREATE INDEX idx_security_rate_limits_shop_action
  ON security_rate_limits(shop_id, action, window_started_at DESC, subject_hash);

CREATE INDEX idx_security_rate_limits_blocked
  ON security_rate_limits(blocked_until, action, id)
  WHERE blocked_until IS NOT NULL;

CREATE TABLE backup_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  scope_key TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'staging', 'production')),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'r2', 'kv', 'configuration')),
  resource_ref TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('time_travel', 'export', 'manifest')),
  provider_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'available', 'failed', 'expired')),
  checksum_sha256 TEXT,
  item_count INTEGER CHECK (item_count IS NULL OR item_count >= 0),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  expires_at TEXT,
  last_safe_error_code TEXT,
  requested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (checksum_sha256 IS NULL OR (length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'))
) STRICT;

CREATE INDEX idx_backup_snapshots_shop_status
  ON backup_snapshots(shop_id, status, created_at DESC, id);

CREATE INDEX idx_backup_snapshots_environment
  ON backup_snapshots(environment, resource_kind, status, created_at DESC, id);

CREATE TABLE restore_drills (
  id TEXT PRIMARY KEY NOT NULL,
  backup_snapshot_id TEXT NOT NULL REFERENCES backup_snapshots(id) ON DELETE RESTRICT,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'staging', 'isolated')),
  target_resource_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'passed', 'failed', 'canceled')),
  integrity_status TEXT NOT NULL DEFAULT 'pending' CHECK (integrity_status IN ('pending', 'ok', 'failed')),
  foreign_key_violation_count INTEGER NOT NULL DEFAULT 0 CHECK (foreign_key_violation_count >= 0),
  restored_item_count INTEGER CHECK (restored_item_count IS NULL OR restored_item_count >= 0),
  last_safe_error_code TEXT,
  requested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_restore_drills_shop_status
  ON restore_drills(shop_id, status, created_at DESC, id);

CREATE INDEX idx_restore_drills_snapshot
  ON restore_drills(backup_snapshot_id, created_at DESC, id);

CREATE INDEX idx_outbox_jobs_shop_ready
  ON outbox_jobs(shop_id, status, next_attempt_at, lease_expires_at, id);

CREATE INDEX idx_outbox_jobs_shop_failed
  ON outbox_jobs(shop_id, updated_at DESC, id)
  WHERE status = 'failed';
