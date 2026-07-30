PRAGMA foreign_keys = ON;

-- Durable onboarding and provider setup tasks store only opaque/internal
-- references. Executors resolve the referenced input after a tenant-scoped
-- claim; provider payloads and credentials never belong in this table.
CREATE TABLE automation_tasks (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  capability_code TEXT NOT NULL CHECK (
    length(capability_code) BETWEEN 3 AND 96
    AND substr(capability_code, 1, 1) GLOB '[a-z]'
    AND capability_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'waiting_user', 'waiting_provider',
    'retryable', 'succeeded', 'failed', 'canceled'
  )),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  input_reference TEXT NOT NULL CHECK (
    length(input_reference) BETWEEN 3 AND 256
    AND instr(input_reference, ':') BETWEEN 2 AND 33
    AND substr(input_reference, 1, 1) GLOB '[a-z]'
    AND substr(input_reference, 1, instr(input_reference, ':') - 1)
      NOT GLOB '*[^a-z0-9._-]*'
    AND substr(input_reference, 1, instr(input_reference, ':') - 1)
      IN ('d1', 'r2', 'audit', 'action')
    AND length(input_reference) - instr(input_reference, ':') BETWEEN 2 AND 223
    AND substr(input_reference, instr(input_reference, ':') + 1, 1)
      GLOB '[A-Za-z0-9]'
    AND substr(input_reference, instr(input_reference, ':') + 1)
      NOT GLOB '*[^A-Za-z0-9._/-]*'
    AND instr(substr(input_reference, instr(input_reference, ':') + 1), '/')
      BETWEEN 3 AND 65
    AND substr(
      substr(input_reference, instr(input_reference, ':') + 1),
      instr(substr(input_reference, instr(input_reference, ':') + 1), '/') + 1, 1
    ) GLOB '[A-Za-z0-9]'
    AND length(substr(input_reference, instr(input_reference, ':') + 1))
      - instr(substr(input_reference, instr(input_reference, ':') + 1), '/')
      BETWEEN 2 AND 128
    AND instr(substr(
      substr(input_reference, instr(input_reference, ':') + 1),
      instr(substr(input_reference, instr(input_reference, ':') + 1), '/') + 1
    ), '/') = 0
    AND instr(input_reference, char(0)) = 0
    AND instr(input_reference, char(10)) = 0
    AND instr(input_reference, char(13)) = 0
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  lease_token TEXT CHECK (
    lease_token IS NULL OR (
      length(lease_token) BETWEEN 16 AND 128
      AND lease_token NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  lease_expires_at TEXT,
  last_safe_error_code TEXT CHECK (
    last_safe_error_code IS NULL
    OR (
      length(last_safe_error_code) BETWEEN 3 AND 96
      AND substr(last_safe_error_code, 1, 1) GLOB '[a-z]'
      AND last_safe_error_code NOT GLOB '*[^a-z0-9._:-]*'
    )
  ),
  audit_log_id TEXT REFERENCES audit_logs(id) ON DELETE SET NULL,
  consent_evidence_reference TEXT CHECK (
    consent_evidence_reference IS NULL
    OR (
      length(consent_evidence_reference) BETWEEN 3 AND 256
      AND instr(consent_evidence_reference, ':') BETWEEN 2 AND 33
      AND substr(consent_evidence_reference, 1, 1) GLOB '[a-z]'
      AND substr(
        consent_evidence_reference, 1,
        instr(consent_evidence_reference, ':') - 1
      ) NOT GLOB '*[^a-z0-9._-]*'
      AND substr(
        consent_evidence_reference, 1,
        instr(consent_evidence_reference, ':') - 1
      ) IN ('d1', 'r2', 'audit', 'action')
      AND length(consent_evidence_reference)
        - instr(consent_evidence_reference, ':') BETWEEN 2 AND 223
      AND substr(
        consent_evidence_reference,
        instr(consent_evidence_reference, ':') + 1, 1
      ) GLOB '[A-Za-z0-9]'
      AND substr(
        consent_evidence_reference,
        instr(consent_evidence_reference, ':') + 1
      ) NOT GLOB '*[^A-Za-z0-9._/-]*'
      AND instr(substr(
        consent_evidence_reference,
        instr(consent_evidence_reference, ':') + 1
      ), '/') BETWEEN 3 AND 65
      AND substr(
        substr(
          consent_evidence_reference,
          instr(consent_evidence_reference, ':') + 1
        ),
        instr(substr(
          consent_evidence_reference,
          instr(consent_evidence_reference, ':') + 1
        ), '/') + 1, 1
      ) GLOB '[A-Za-z0-9]'
      AND length(substr(
        consent_evidence_reference,
        instr(consent_evidence_reference, ':') + 1
      )) - instr(substr(
        consent_evidence_reference,
        instr(consent_evidence_reference, ':') + 1
      ), '/') BETWEEN 2 AND 128
    )
  ),
  action_reference TEXT CHECK (
    action_reference IS NULL OR (
      length(action_reference) BETWEEN 3 AND 256
      AND instr(action_reference, ':') BETWEEN 2 AND 33
      AND substr(action_reference, 1, 1) GLOB '[a-z]'
      AND substr(action_reference, 1, instr(action_reference, ':') - 1)
        NOT GLOB '*[^a-z0-9._-]*'
      AND substr(action_reference, 1, instr(action_reference, ':') - 1)
        IN ('d1', 'r2', 'audit', 'action')
      AND length(action_reference) - instr(action_reference, ':') BETWEEN 2 AND 223
      AND substr(action_reference, instr(action_reference, ':') + 1, 1)
        GLOB '[A-Za-z0-9]'
      AND substr(action_reference, instr(action_reference, ':') + 1)
        NOT GLOB '*[^A-Za-z0-9._/-]*'
      AND instr(substr(action_reference, instr(action_reference, ':') + 1), '/')
        BETWEEN 3 AND 65
      AND substr(
        substr(action_reference, instr(action_reference, ':') + 1),
        instr(substr(action_reference, instr(action_reference, ':') + 1), '/') + 1, 1
      ) GLOB '[A-Za-z0-9]'
      AND length(substr(action_reference, instr(action_reference, ':') + 1))
        - instr(substr(action_reference, instr(action_reference, ':') + 1), '/')
        BETWEEN 2 AND 128
    )
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, shop_id),
  CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status != 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status = 'retryable' AND next_attempt_at IS NOT NULL)
    OR (status != 'retryable' AND next_attempt_at IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_automation_tasks_shop_idempotency
  ON automation_tasks(shop_id, capability_code, idempotency_key_hash);

CREATE INDEX idx_automation_tasks_shop_status_due
  ON automation_tasks(
    shop_id, status, next_attempt_at, lease_expires_at, updated_at, id
  );

-- The scheduled system worker scans all tenants, then claims each row with its
-- shop_id and version. Tenant-facing reads never use this global index alone.
CREATE INDEX idx_automation_tasks_system_due
  ON automation_tasks(
    status, next_attempt_at, lease_expires_at, updated_at, id, shop_id
  ) WHERE status IN ('pending', 'retryable', 'running');

-- A task row is the current projection. This append-only stream preserves who
-- requested each transition and which safe, reference-only evidence supported
-- it without retaining provider payloads or credentials.
CREATE TABLE automation_task_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  task_id TEXT NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  from_status TEXT CHECK (
    from_status IS NULL OR from_status IN (
      'pending', 'running', 'waiting_user', 'waiting_provider',
      'retryable', 'succeeded', 'failed', 'canceled'
    )
  ),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'pending', 'running', 'waiting_user', 'waiting_provider',
    'retryable', 'succeeded', 'failed', 'canceled'
  )),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('seller', 'operator', 'system')),
  actor_id TEXT NOT NULL CHECK (
    length(actor_id) BETWEEN 3 AND 128
    AND substr(actor_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  audit_log_id TEXT REFERENCES audit_logs(id) ON DELETE RESTRICT,
  safe_code TEXT CHECK (
    safe_code IS NULL OR (
      length(safe_code) BETWEEN 3 AND 96
      AND substr(safe_code, 1, 1) GLOB '[a-z]'
      AND safe_code NOT GLOB '*[^a-z0-9._:-]*'
    )
  ),
  evidence_reference TEXT CHECK (
    evidence_reference IS NULL OR (
      length(evidence_reference) BETWEEN 3 AND 256
      AND instr(evidence_reference, ':') BETWEEN 2 AND 33
      AND substr(evidence_reference, 1, 1) GLOB '[a-z]'
      AND substr(evidence_reference, 1, instr(evidence_reference, ':') - 1)
        NOT GLOB '*[^a-z0-9._-]*'
      AND substr(evidence_reference, 1, instr(evidence_reference, ':') - 1)
        IN ('d1', 'r2', 'audit', 'action')
      AND length(evidence_reference) - instr(evidence_reference, ':') BETWEEN 2 AND 223
      AND substr(evidence_reference, instr(evidence_reference, ':') + 1, 1)
        GLOB '[A-Za-z0-9]'
      AND substr(evidence_reference, instr(evidence_reference, ':') + 1)
        NOT GLOB '*[^A-Za-z0-9._/-]*'
      AND instr(substr(evidence_reference, instr(evidence_reference, ':') + 1), '/')
        BETWEEN 3 AND 65
      AND substr(
        substr(evidence_reference, instr(evidence_reference, ':') + 1),
        instr(substr(evidence_reference, instr(evidence_reference, ':') + 1), '/') + 1, 1
      ) GLOB '[A-Za-z0-9]'
      AND length(substr(evidence_reference, instr(evidence_reference, ':') + 1))
        - instr(substr(evidence_reference, instr(evidence_reference, ':') + 1), '/')
        BETWEEN 2 AND 128
    )
  ),
  action_reference TEXT CHECK (
    action_reference IS NULL OR (
      length(action_reference) BETWEEN 3 AND 256
      AND instr(action_reference, ':') BETWEEN 2 AND 33
      AND substr(action_reference, 1, 1) GLOB '[a-z]'
      AND substr(action_reference, 1, instr(action_reference, ':') - 1)
        NOT GLOB '*[^a-z0-9._-]*'
      AND substr(action_reference, 1, instr(action_reference, ':') - 1)
        IN ('d1', 'r2', 'audit', 'action')
      AND length(action_reference) - instr(action_reference, ':') BETWEEN 2 AND 223
      AND substr(action_reference, instr(action_reference, ':') + 1, 1)
        GLOB '[A-Za-z0-9]'
      AND substr(action_reference, instr(action_reference, ':') + 1)
        NOT GLOB '*[^A-Za-z0-9._/-]*'
      AND instr(substr(action_reference, instr(action_reference, ':') + 1), '/')
        BETWEEN 3 AND 65
      AND substr(
        substr(action_reference, instr(action_reference, ':') + 1),
        instr(substr(action_reference, instr(action_reference, ':') + 1), '/') + 1, 1
      ) GLOB '[A-Za-z0-9]'
      AND length(substr(action_reference, instr(action_reference, ':') + 1))
        - instr(substr(action_reference, instr(action_reference, ':') + 1), '/')
        BETWEEN 2 AND 128
    )
  ),
  task_version INTEGER NOT NULL CHECK (task_version > 0),
  created_at TEXT NOT NULL,
  UNIQUE (task_id, task_version),
  FOREIGN KEY (task_id, shop_id)
    REFERENCES automation_tasks(id, shop_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_automation_task_events_shop_task
  ON automation_task_events(shop_id, task_id, created_at, id);

CREATE INDEX idx_automation_task_events_shop_created
  ON automation_task_events(shop_id, created_at DESC, id);

CREATE TRIGGER automation_task_events_immutable_update
BEFORE UPDATE ON automation_task_events
BEGIN
  SELECT RAISE(ABORT, 'automation_task_events_immutable');
END;

CREATE TRIGGER automation_task_events_immutable_delete
BEFORE DELETE ON automation_task_events
BEGIN
  SELECT RAISE(ABORT, 'automation_task_events_immutable');
END;
