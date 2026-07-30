PRAGMA foreign_keys = ON;

-- Provider account identity is retained while a connection is live so a
-- reconnect cannot silently claim another merchant. Shop deletion is the
-- only operation allowed to release those claims after provider cleanup and
-- the destructive crypto-shred lease have both been admitted.
DROP TRIGGER IF EXISTS payment_provider_connections_identity_immutable;

CREATE TRIGGER payment_provider_connections_identity_immutable
BEFORE UPDATE ON payment_provider_connections
WHEN
  NEW.id != OLD.id
  OR NEW.public_id != OLD.public_id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.provider_environment != OLD.provider_environment
  OR NEW.connection_mode != OLD.connection_mode
  OR NEW.settlement_mode != OLD.settlement_mode
  OR NEW.credential_ownership != OLD.credential_ownership
  OR NEW.merchant_country_code IS NOT OLD.merchant_country_code
  OR NEW.legacy_payos_integration_id IS NOT OLD.legacy_payos_integration_id
  OR (
    (
      (OLD.provider_attested_country_code IS NOT NULL
        AND NEW.provider_attested_country_code IS NOT OLD.provider_attested_country_code)
      OR (OLD.provider_country_attested_at IS NOT NULL
        AND NEW.provider_country_attested_at IS NOT OLD.provider_country_attested_at)
      OR (OLD.provider_account_fingerprint IS NOT NULL
        AND NEW.provider_account_fingerprint IS NOT OLD.provider_account_fingerprint)
      OR (OLD.provider_account_verified_at IS NOT NULL
        AND NEW.provider_account_verified_at IS NOT OLD.provider_account_verified_at)
    )
    AND NOT (
      NEW.status = 'disconnected'
      AND NEW.webhook_status = 'disconnected'
      AND NEW.provider_attested_country_code IS NULL
      AND NEW.provider_country_attested_at IS NULL
      AND NEW.provider_account_fingerprint IS NULL
      AND NEW.provider_account_verified_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM shop_deletion_steps AS shred_step
        INNER JOIN shop_deletion_requests AS shred_request
          ON shred_request.id = shred_step.request_id
          AND shred_request.shop_id = shred_step.shop_id
        WHERE shred_step.shop_id = NEW.shop_id
          AND shred_step.step_code = 'crypto_shred'
          AND shred_step.status = 'processing'
          AND shred_step.lease_token IS NOT NULL
          AND shred_step.lease_expires_at > NEW.updated_at
          AND shred_request.status IN ('processing', 'blocked', 'retention_hold', 'failed')
          AND shred_request.provider_cleanup_completed_at IS NOT NULL
          AND shred_request.grace_ends_at <= NEW.updated_at
          AND (
            shred_request.legal_hold_until IS NULL
            OR shred_request.legal_hold_until <= NEW.updated_at
          )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_identity_immutable');
END;
