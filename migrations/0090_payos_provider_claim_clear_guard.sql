PRAGMA foreign_keys = ON;

-- A pre-fencing request can finish after 0089 and try to release only the
-- fingerprints. That would discard the provider binding while leaving the
-- quarantine nonce behind. Permit only explicit idle cleanup or the current
-- fenced definitive-finalization transition.
CREATE TRIGGER payment_integrations_payos_claim_fingerprint_clear_guard
BEFORE UPDATE OF provider_identity_fingerprint ON payment_integrations
WHEN NEW.provider = 'payos'
  AND OLD.provider_identity_fingerprint IS NOT NULL
  AND NEW.provider_identity_fingerprint IS NULL
  AND NOT (
    (
      OLD.provider_claim_nonce IS NULL
      AND OLD.provider_claim_state = 'idle'
      AND OLD.provider_claim_target_fingerprint IS NULL
      AND NEW.provider_claim_nonce IS NULL
      AND NEW.provider_claim_state = 'idle'
      AND NEW.provider_claim_target_fingerprint IS NULL
    )
    OR (
      OLD.provider_claim_nonce IS NOT NULL
      AND OLD.provider_claim_state = 'in_flight'
      AND OLD.provider_claim_target_fingerprint IS NOT NULL
      AND NEW.provider_claim_generation = OLD.provider_claim_generation
      AND NEW.provider_claim_nonce IS NULL
      AND NEW.provider_claim_state = 'idle'
      AND NEW.provider_claim_target_fingerprint IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payos_provider_identity_clear_unfenced');
END;

CREATE TRIGGER payment_credentials_payos_claim_fingerprint_clear_guard
BEFORE UPDATE OF provider_ownership_fingerprint ON payment_credentials
WHEN NEW.provider = 'payos'
  AND OLD.provider_ownership_fingerprint IS NOT NULL
  AND NEW.provider_ownership_fingerprint IS NULL
  AND NEW.key_version != 'destroyed'
  AND NOT (
    (
      OLD.provider_claim_nonce IS NULL
      AND NEW.provider_claim_nonce IS NULL
      AND EXISTS (
        SELECT 1
        FROM payment_integrations AS integration
        WHERE integration.id = NEW.integration_id
          AND integration.shop_id = NEW.shop_id
          AND integration.provider = NEW.provider
          AND integration.provider_claim_nonce IS NULL
          AND integration.provider_claim_state = 'idle'
          AND integration.provider_claim_target_fingerprint IS NULL
      )
    )
    OR (
      OLD.provider_claim_nonce IS NOT NULL
      AND NEW.provider_claim_nonce IS NULL
      AND EXISTS (
        SELECT 1
        FROM payment_integrations AS integration
        WHERE integration.id = NEW.integration_id
          AND integration.shop_id = NEW.shop_id
          AND integration.provider = NEW.provider
          AND integration.provider_claim_nonce = OLD.provider_claim_nonce
          AND integration.provider_claim_state = 'in_flight'
          AND integration.provider_claim_target_fingerprint IS NOT NULL
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payos_provider_credential_clear_unfenced');
END;
