PRAGMA foreign_keys = ON;

-- Opaque continuation challenges never carry task, tenant or actor IDs to the
-- browser. The random token is hashed; the durable row binds consent/provider
-- evidence to one task, tenant and actor before an immutable task transition.
CREATE TABLE automation_evidence_challenges (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  task_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('approval_granted', 'external_action_completed')),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('issued', 'consumed', 'revoked')),
  audit_log_id TEXT REFERENCES audit_logs(id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id, shop_id)
    REFERENCES automation_tasks(id, shop_id) ON DELETE RESTRICT,
  CHECK (
    (
      status = 'consumed'
      AND consumed_at IS NOT NULL
      AND consumed_at <= expires_at
      AND audit_log_id IS NOT NULL
    )
    OR (status != 'consumed' AND consumed_at IS NULL AND audit_log_id IS NULL)
  )
) STRICT;

CREATE INDEX idx_automation_evidence_task_status
  ON automation_evidence_challenges(shop_id, task_id, status, expires_at, created_at DESC);

CREATE TRIGGER automation_evidence_insert_guard
BEFORE INSERT ON automation_evidence_challenges
FOR EACH ROW
WHEN
  NEW.status != 'issued'
  OR NEW.consumed_at IS NOT NULL
  OR NEW.audit_log_id IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM shop_members
    WHERE shop_id = NEW.shop_id
      AND user_id = NEW.actor_user_id
      AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'automation_evidence_insert_invalid');
END;

CREATE TRIGGER automation_evidence_transition_guard
BEFORE UPDATE ON automation_evidence_challenges
FOR EACH ROW
WHEN
  NEW.id != OLD.id
  OR NEW.task_id != OLD.task_id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.actor_user_id != OLD.actor_user_id
  OR NEW.kind != OLD.kind
  OR NEW.token_hash != OLD.token_hash
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_at != OLD.created_at
  OR OLD.status != 'issued'
  OR NEW.status NOT IN ('consumed', 'revoked')
  OR (
    NEW.status = 'consumed'
    AND (
      NEW.consumed_at > NEW.expires_at
      OR
      NOT EXISTS (
        SELECT 1
        FROM shop_members
        WHERE shop_id = NEW.shop_id
          AND user_id = NEW.actor_user_id
          AND status = 'active'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM audit_logs
        WHERE id = NEW.audit_log_id
          AND shop_id = NEW.shop_id
          AND actor_type = 'user'
          AND actor_id = NEW.actor_user_id
          AND action = 'automation.evidence_consumed'
          AND resource_type = 'automation_evidence'
          AND resource_id = NEW.id
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'automation_evidence_transition_invalid');
END;

CREATE TRIGGER automation_evidence_immutable_delete
BEFORE DELETE ON automation_evidence_challenges
BEGIN
  SELECT RAISE(ABORT, 'automation_evidence_immutable');
END;

-- D1 serializes the insert and trigger evaluation, so concurrent task creates
-- cannot bypass the tenant open-task ceiling with a count-then-insert race.
CREATE TRIGGER automation_open_task_limit
BEFORE INSERT ON automation_tasks
FOR EACH ROW
WHEN NEW.status NOT IN ('succeeded', 'failed', 'canceled')
  AND (
    SELECT COUNT(*)
    FROM automation_tasks
    WHERE shop_id = NEW.shop_id
      AND status NOT IN ('succeeded', 'failed', 'canceled')
  ) >= 100
BEGIN
  SELECT RAISE(ABORT, 'automation_open_task_limit');
END;

CREATE TRIGGER automation_open_task_limit_update
BEFORE UPDATE OF status, shop_id ON automation_tasks
FOR EACH ROW
WHEN NEW.status NOT IN ('succeeded', 'failed', 'canceled')
  AND (
    OLD.status IN ('succeeded', 'failed', 'canceled')
    OR NEW.shop_id != OLD.shop_id
  )
  AND (
    SELECT COUNT(*)
    FROM automation_tasks
    WHERE shop_id = NEW.shop_id
      AND status NOT IN ('succeeded', 'failed', 'canceled')
  ) >= 100
BEGIN
  SELECT RAISE(ABORT, 'automation_open_task_limit');
END;
