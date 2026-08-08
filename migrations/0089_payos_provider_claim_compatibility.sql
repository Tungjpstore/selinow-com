PRAGMA foreign_keys = ON;

-- An older worker may have written provisional ownership after 0088 but
-- before these compatibility guards were installed. Quarantine those rows so
-- they remain owned and can only be reconciled by their tenant-bound runtime.
UPDATE payment_integrations
SET provider_claim_generation = provider_claim_generation + 1,
    provider_claim_nonce = 'legacy_0089_' || lower(hex(randomblob(16))),
    provider_claim_state = 'quarantined'
WHERE provider = 'payos'
  AND provider_identity_fingerprint IS NOT NULL
  AND active_credential_id IS NULL
  AND status IN ('pending', 'error')
  AND provider_claim_nonce IS NULL
  AND provider_claim_state = 'idle'
  AND provider_claim_target_fingerprint IS NULL;

UPDATE payment_credentials
SET provider_claim_nonce = (
  SELECT integration.provider_claim_nonce
  FROM payment_integrations AS integration
  WHERE integration.id = payment_credentials.integration_id
    AND integration.shop_id = payment_credentials.shop_id
    AND integration.provider = payment_credentials.provider
)
WHERE provider = 'payos'
  AND provider_ownership_fingerprint IS NOT NULL
  AND status IN ('pending', 'error')
  AND provider_claim_nonce IS NULL
  AND EXISTS (
    SELECT 1
    FROM payment_integrations AS integration
    WHERE integration.id = payment_credentials.integration_id
      AND integration.shop_id = payment_credentials.shop_id
      AND integration.provider = payment_credentials.provider
      AND integration.provider_claim_state = 'quarantined'
      AND integration.provider_claim_nonce IS NOT NULL
      AND integration.provider_claim_target_fingerprint IS NULL
  );

-- UPDATE OF fires even when an old worker writes the existing fingerprint.
-- Admit only a fresh fenced claim or the current runtime's fenced finalization.
CREATE TRIGGER payment_integrations_payos_claim_fingerprint_update_guard
BEFORE UPDATE OF provider_identity_fingerprint ON payment_integrations
WHEN NEW.provider = 'payos'
  AND NEW.provider_identity_fingerprint IS NOT NULL
  AND NOT (
    (
      NEW.provider_claim_generation = OLD.provider_claim_generation + 1
      AND NEW.provider_claim_nonce IS NOT NULL
      AND NEW.provider_claim_nonce IS NOT OLD.provider_claim_nonce
      AND NEW.provider_claim_state IN ('in_flight', 'quarantined')
      AND NEW.provider_claim_target_fingerprint IS NOT NULL
    )
    OR (
      NEW.provider_identity_fingerprint IS OLD.provider_identity_fingerprint
      AND NEW.provider_claim_generation = OLD.provider_claim_generation
      AND OLD.provider_claim_nonce IS NOT NULL
      AND OLD.provider_claim_state IN ('in_flight', 'quarantined')
      AND OLD.provider_claim_target_fingerprint IS NOT NULL
      AND NEW.provider_claim_nonce IS NULL
      AND (
        (
          NEW.provider_claim_state = 'idle'
          AND NEW.provider_claim_target_fingerprint IS NULL
        )
        OR (
          NEW.provider_claim_state = 'quarantined'
          AND NEW.provider_claim_target_fingerprint IS OLD.provider_claim_target_fingerprint
        )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payos_provider_identity_claim_unfenced');
END;

CREATE TRIGGER payment_credentials_payos_claim_fingerprint_update_guard
BEFORE UPDATE OF provider_ownership_fingerprint ON payment_credentials
WHEN NEW.provider = 'payos'
  AND NEW.provider_ownership_fingerprint IS NOT NULL
  AND NEW.key_version != 'destroyed'
  AND NOT (
    (
      NEW.provider_claim_nonce IS NOT NULL
      AND NEW.provider_claim_nonce IS NOT OLD.provider_claim_nonce
      AND EXISTS (
        SELECT 1
        FROM payment_integrations AS integration
        WHERE integration.id = NEW.integration_id
          AND integration.shop_id = NEW.shop_id
          AND integration.provider = NEW.provider
          AND integration.provider_identity_fingerprint IS NOT NULL
          AND integration.provider_claim_nonce = NEW.provider_claim_nonce
          AND integration.provider_claim_state IN ('in_flight', 'quarantined')
          AND integration.provider_claim_target_fingerprint IS NOT NULL
      )
    )
    OR (
      NEW.provider_ownership_fingerprint IS OLD.provider_ownership_fingerprint
      AND OLD.provider_claim_nonce IS NOT NULL
      AND NEW.provider_claim_nonce IS NULL
      AND EXISTS (
        SELECT 1
        FROM payment_integrations AS integration
        WHERE integration.id = NEW.integration_id
          AND integration.shop_id = NEW.shop_id
          AND integration.provider = NEW.provider
          AND integration.provider_claim_nonce = OLD.provider_claim_nonce
          AND integration.provider_claim_state IN ('in_flight', 'quarantined')
          AND integration.provider_claim_target_fingerprint IS NOT NULL
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payos_provider_credential_claim_unfenced');
END;
