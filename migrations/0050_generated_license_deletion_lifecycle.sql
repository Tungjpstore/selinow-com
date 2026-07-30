PRAGMA foreign_keys = ON;

-- Deletion crypto-shredding is a forward-only lifecycle transition. Retired
-- provider connections may clear their account fingerprint, and revoked
-- artifacts may be destroyed without rewriting immutable request evidence.
DROP TRIGGER generated_license_connections_identity_guard;

CREATE TRIGGER generated_license_connections_identity_guard
BEFORE UPDATE ON generated_license_provider_connections
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.provider_environment != OLD.provider_environment
  OR NEW.descriptor_version != OLD.descriptor_version
  OR (
    NEW.external_account_fingerprint IS NOT OLD.external_account_fingerprint
    AND NOT (NEW.status = 'retired' AND NEW.external_account_fingerprint IS NULL)
  )
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NOT (
    (OLD.status IN ('active', 'degraded', 'disabled') AND NEW.status IN ('active', 'degraded', 'disabled', 'retired'))
    OR (OLD.status = 'retired' AND NEW.status = 'retired')
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_connection_identity_immutable');
END;

DROP TRIGGER generated_license_artifacts_transition_guard;

CREATE TRIGGER generated_license_artifacts_transition_guard
BEFORE UPDATE ON generated_license_artifacts
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.request_id != OLD.request_id
  OR NEW.entitlement_id != OLD.entitlement_id
  OR NEW.ordinal != OLD.ordinal
  OR (
    NEW.status != 'destroyed'
    AND (
      NEW.ciphertext_b64 != OLD.ciphertext_b64
      OR NEW.iv_b64 != OLD.iv_b64
      OR NEW.key_version != OLD.key_version
      OR NEW.artifact_fingerprint != OLD.artifact_fingerprint
    )
  )
  OR (
    NEW.status = 'destroyed'
    AND (
      NEW.ciphertext_b64 != 'destroyed'
      OR NEW.iv_b64 != 'destroyed'
      OR NEW.key_version != 'destroyed'
      OR NEW.artifact_fingerprint != 'destroyed'
    )
  )
  OR NEW.format != OLD.format
  OR NEW.created_at != OLD.created_at
  OR NOT (
    (OLD.status IN ('active', 'revoked') AND NEW.status IN ('active', 'revoked', 'destroyed'))
    OR (OLD.status = 'destroyed' AND NEW.status = 'destroyed')
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_artifact_identity_immutable');
END;
