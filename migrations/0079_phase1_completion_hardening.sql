PRAGMA foreign_keys = ON;

-- Projection fields are enum dimensions only. Enforce the same contract at
-- the D1 boundary so direct maintenance writes cannot add arbitrary JSON.
CREATE TRIGGER activation_milestones_projection_insert_guard
BEFORE INSERT ON activation_milestones
WHEN json_type(NEW.projection_json) != 'object'
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.projection_json)
    WHERE key NOT IN ('channel', 'currency', 'fulfillment_type', 'trigger')
      OR type != 'text'
      OR (key = 'channel' AND value NOT IN ('website', 'telegram'))
      OR (key = 'currency' AND value NOT IN ('VND', 'USD', 'EUR', 'JPY'))
      OR (key = 'fulfillment_type' AND value NOT IN ('license_key', 'manual'))
      OR (key = 'trigger' AND value NOT IN ('manual', 'publish', 'test'))
  )
BEGIN
  SELECT RAISE(ABORT, 'activation_projection_invalid');
END;

CREATE TRIGGER activation_milestones_projection_update_guard
BEFORE UPDATE OF projection_json ON activation_milestones
WHEN json_type(NEW.projection_json) != 'object'
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.projection_json)
    WHERE key NOT IN ('channel', 'currency', 'fulfillment_type', 'trigger')
      OR type != 'text'
      OR (key = 'channel' AND value NOT IN ('website', 'telegram'))
      OR (key = 'currency' AND value NOT IN ('VND', 'USD', 'EUR', 'JPY'))
      OR (key = 'fulfillment_type' AND value NOT IN ('license_key', 'manual'))
      OR (key = 'trigger' AND value NOT IN ('manual', 'publish', 'test'))
  )
BEGIN
  SELECT RAISE(ABORT, 'activation_projection_invalid');
END;

-- The cursor is operational state only. Activation milestones remain derived
-- from authoritative tenant data and are safe to rebuild repeatedly.
CREATE TABLE activation_backfill_checkpoints (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'global'),
  last_shop_id TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO activation_backfill_checkpoints (id, last_shop_id, updated_at)
VALUES ('global', NULL, '1970-01-01T00:00:00.000Z');

-- The legacy table CHECK requires reviewer fields to be cleared when provider
-- evidence completes a request. Permit that single terminal transition.
DROP TRIGGER IF EXISTS subscription_change_requests_transition_guard;

CREATE TRIGGER subscription_change_requests_transition_guard
BEFORE UPDATE ON subscription_change_requests
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.subscription_id != OLD.subscription_id
  OR NEW.current_plan_id != OLD.current_plan_id
  OR NEW.requested_plan_id IS NOT OLD.requested_plan_id
  OR NEW.action != OLD.action
  OR NEW.expected_subscription_version != OLD.expected_subscription_version
  OR NEW.reason_code != OLD.reason_code
  OR NEW.requested_by_user_id != OLD.requested_by_user_id
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NEW.execution_attempts < OLD.execution_attempts
  OR NEW.execution_attempts > OLD.execution_attempts + 1
  OR (NEW.reviewed_by_user_id IS NOT OLD.reviewed_by_user_id AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected', 'completed'))
  OR (NEW.reviewed_at IS NOT OLD.reviewed_at AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected', 'completed'))
  OR (NEW.provider_action_ref IS NOT OLD.provider_action_ref AND NEW.status NOT IN ('requested', 'provider_pending', 'completed', 'rejected'))
  OR (NEW.provider_event_id IS NOT OLD.provider_event_id AND NEW.status != 'completed')
  OR (NEW.last_attempt_at IS NOT OLD.last_attempt_at AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected'))
  OR OLD.status IN ('completed', 'canceled', 'rejected')
  OR NOT (
    (OLD.status = 'requested' AND NEW.status IN ('requested', 'provider_pending', 'rejected', 'canceled'))
    OR (OLD.status = 'provider_pending' AND NEW.status IN ('provider_pending', 'requested', 'completed', 'rejected', 'canceled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_change_request_transition_invalid');
END;
