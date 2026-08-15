PRAGMA foreign_keys = ON;

ALTER TABLE payment_integrations
  ADD COLUMN provider_claim_generation INTEGER NOT NULL DEFAULT 0
  CHECK (provider_claim_generation >= 0);

ALTER TABLE payment_integrations
  ADD COLUMN provider_claim_nonce TEXT
  CHECK (
    provider_claim_nonce IS NULL OR (
      length(provider_claim_nonce) BETWEEN 32 AND 128
      AND provider_claim_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  );

ALTER TABLE payment_integrations
  ADD COLUMN provider_claim_state TEXT NOT NULL DEFAULT 'idle'
  CHECK (provider_claim_state IN ('idle', 'in_flight', 'ambiguous', 'quarantined'));

ALTER TABLE payment_integrations
  ADD COLUMN provider_claim_target_fingerprint TEXT
  CHECK (
    provider_claim_target_fingerprint IS NULL OR (
      length(provider_claim_target_fingerprint) = 43
      AND provider_claim_target_fingerprint NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  );

ALTER TABLE payment_credentials
  ADD COLUMN provider_claim_nonce TEXT
  CHECK (
    provider_claim_nonce IS NULL OR (
      length(provider_claim_nonce) BETWEEN 32 AND 128
      AND provider_claim_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  );

-- A pending/error fingerprint from an older runtime may represent a provider
-- write whose response was lost. Preserve it as quarantined until reconciled.
UPDATE payment_integrations
SET provider_claim_generation = 1,
    provider_claim_nonce = 'legacy_' || replace(id, '-', '_'),
    provider_claim_state = 'quarantined'
WHERE provider = 'payos'
  AND provider_identity_fingerprint IS NOT NULL
  AND active_credential_id IS NULL
  AND status IN ('pending', 'error');

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
  AND EXISTS (
    SELECT 1
    FROM payment_integrations AS integration
    WHERE integration.id = payment_credentials.integration_id
      AND integration.shop_id = payment_credentials.shop_id
      AND integration.provider = payment_credentials.provider
      AND integration.provider_claim_state = 'quarantined'
  );

CREATE UNIQUE INDEX idx_payment_integrations_provider_claim_nonce
  ON payment_integrations(provider_claim_nonce)
  WHERE provider_claim_nonce IS NOT NULL;

CREATE TRIGGER payment_integrations_payos_claim_state_insert_guard
BEFORE INSERT ON payment_integrations
WHEN NOT (
  (NEW.provider_claim_state = 'idle'
    AND NEW.provider_claim_nonce IS NULL
    AND NEW.provider_claim_target_fingerprint IS NULL)
  OR (NEW.provider_claim_state IN ('in_flight', 'ambiguous')
    AND NEW.provider_claim_nonce IS NOT NULL
    AND NEW.provider_claim_target_fingerprint IS NOT NULL)
  OR NEW.provider_claim_state = 'quarantined'
)
BEGIN
  SELECT RAISE(ABORT, 'payos_provider_claim_state_invalid');
END;

CREATE TRIGGER payment_integrations_payos_claim_state_update_guard
BEFORE UPDATE OF provider_claim_nonce, provider_claim_state, provider_claim_target_fingerprint
ON payment_integrations
WHEN NOT (
  (NEW.provider_claim_state = 'idle'
    AND NEW.provider_claim_nonce IS NULL
    AND NEW.provider_claim_target_fingerprint IS NULL)
  OR (NEW.provider_claim_state IN ('in_flight', 'ambiguous')
    AND NEW.provider_claim_nonce IS NOT NULL
    AND NEW.provider_claim_target_fingerprint IS NOT NULL)
  OR NEW.provider_claim_state = 'quarantined'
)
BEGIN
  SELECT RAISE(ABORT, 'payos_provider_claim_state_invalid');
END;

CREATE TRIGGER payment_credentials_payos_claim_scope_insert_guard
BEFORE INSERT ON payment_credentials
WHEN NEW.provider_claim_nonce IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM payment_integrations AS integration
    WHERE integration.id = NEW.integration_id
      AND integration.shop_id = NEW.shop_id
      AND integration.provider = NEW.provider
      AND integration.provider_claim_nonce = NEW.provider_claim_nonce
  )
BEGIN
  SELECT RAISE(ABORT, 'payos_provider_claim_scope_mismatch');
END;

CREATE TRIGGER payment_credentials_payos_claim_scope_update_guard
BEFORE UPDATE OF shop_id, integration_id, provider, provider_claim_nonce
ON payment_credentials
WHEN NEW.provider_claim_nonce IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM payment_integrations AS integration
    WHERE integration.id = NEW.integration_id
      AND integration.shop_id = NEW.shop_id
      AND integration.provider = NEW.provider
      AND integration.provider_claim_nonce = NEW.provider_claim_nonce
  )
BEGIN
  SELECT RAISE(ABORT, 'payos_provider_claim_scope_mismatch');
END;
