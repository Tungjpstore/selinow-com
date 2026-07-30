PRAGMA foreign_keys = ON;

CREATE TRIGGER generated_license_requests_initial_state_guard
BEFORE INSERT ON generated_license_requests
WHEN NEW.status != 'pending'
  OR NEW.attempt_count != 0
  OR NEW.version != 1
  OR NEW.lease_token IS NOT NULL
  OR NEW.lease_expires_at IS NOT NULL
  OR NEW.last_safe_error_code IS NOT NULL
  OR NEW.provider_reference_hash IS NOT NULL
  OR NEW.evidence_hash IS NOT NULL
  OR NEW.succeeded_at IS NOT NULL
  OR NEW.canceled_at IS NOT NULL
  OR NEW.updated_at != NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'generated_license_request_initial_state_invalid');
END;

-- Requests are mutable only while provider work is active. Succeeded and
-- canceled rows are retained as terminal evidence and cannot be rewritten.
DROP TRIGGER generated_license_requests_transition_guard;

CREATE TRIGGER generated_license_requests_transition_guard
BEFORE UPDATE ON generated_license_requests
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.requirement_snapshot_id != OLD.requirement_snapshot_id
  OR NEW.entitlement_id != OLD.entitlement_id
  OR NEW.entitlement_grant_id != OLD.entitlement_grant_id
  OR NEW.order_id != OLD.order_id
  OR NEW.resource_id != OLD.resource_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.unit_ordinal != OLD.unit_ordinal
  OR NEW.provider_idempotency_key_hash != OLD.provider_idempotency_key_hash
  OR NEW.request_hash != OLD.request_hash
  OR NEW.credential_version != OLD.credential_version
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status IN ('succeeded', 'canceled')
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('pending', 'processing', 'canceled'))
    OR (OLD.status = 'processing' AND NEW.status IN (
      'processing', 'retryable', 'reconcile_pending', 'succeeded', 'failed',
      'manual_review', 'canceled'
    ))
    OR (OLD.status = 'retryable' AND NEW.status IN ('retryable', 'processing', 'canceled'))
    OR (OLD.status = 'reconcile_pending' AND NEW.status IN ('reconcile_pending', 'processing', 'canceled'))
    OR (OLD.status = 'failed' AND NEW.status IN ('failed', 'retryable', 'manual_review'))
    OR (OLD.status = 'manual_review' AND NEW.status IN ('manual_review', 'retryable'))
  )
  OR (
    NEW.status = 'processing'
    AND OLD.status != 'processing'
    AND NEW.attempt_count != OLD.attempt_count + 1
  )
  OR (
    NEW.status = 'processing'
    AND OLD.status = 'processing'
    AND (
      NEW.attempt_count != OLD.attempt_count + 1
      OR OLD.lease_expires_at > NEW.updated_at
    )
  )
  OR (NEW.status != 'processing' AND NEW.attempt_count != OLD.attempt_count)
  OR (NEW.status = 'processing' AND NEW.attempt_count <= 0)
  OR (
    OLD.provider_reference_hash IS NOT NULL
    AND NEW.provider_reference_hash IS NULL
  )
  OR (
    OLD.evidence_hash IS NOT NULL
    AND NEW.evidence_hash IS NULL
  )
  OR (
    (
      NEW.provider_reference_hash IS NOT OLD.provider_reference_hash
      OR NEW.evidence_hash IS NOT OLD.evidence_hash
    )
    AND NOT (
      OLD.status = 'processing'
      AND NEW.status IN ('retryable', 'reconcile_pending', 'succeeded', 'failed', 'manual_review')
    )
  )
  OR (
    NEW.succeeded_at IS NOT OLD.succeeded_at
    AND NOT (OLD.status = 'processing' AND NEW.status = 'succeeded')
  )
  OR (
    NEW.canceled_at IS NOT OLD.canceled_at
    AND NOT (
      OLD.status IN ('pending', 'processing', 'retryable', 'reconcile_pending')
      AND NEW.status = 'canceled'
    )
  )
  OR (
    OLD.status != 'succeeded'
    AND NEW.status = 'succeeded'
    AND (
      NEW.succeeded_at != NEW.updated_at
      OR NEW.provider_reference_hash IS NULL
      OR NEW.evidence_hash IS NULL
      OR NEW.attempt_count <= 0
    )
  )
  OR (
    OLD.status != 'canceled'
    AND NEW.status = 'canceled'
    AND (
      NEW.canceled_at != NEW.updated_at
      OR NEW.last_safe_error_code IS NULL
    )
  )
  OR (
    NEW.status = 'succeeded'
    AND NEW.last_safe_error_code IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_request_transition_invalid');
END;

-- The global scheduler has no tenant predicate and treats expired processing
-- leases separately from ordinary due work.
CREATE INDEX idx_generated_license_requests_global_due
  ON generated_license_requests(status, next_attempt_at, id, shop_id)
  WHERE status IN ('pending', 'retryable', 'reconcile_pending');

CREATE INDEX idx_generated_license_requests_global_lease
  ON generated_license_requests(status, lease_expires_at, id, shop_id)
  WHERE status = 'processing' AND lease_expires_at IS NOT NULL;

-- Rotation discovers source-version rows globally or within one tenant.
CREATE INDEX idx_generated_license_credentials_key_version
  ON generated_license_provider_credentials(key_version, shop_id, id);

CREATE INDEX idx_generated_license_artifacts_key_version
  ON generated_license_artifacts(key_version, shop_id, id);
