PRAGMA foreign_keys = ON;

-- Explicit owner disconnects preserve the old credential for pending webhook
-- verification, while allowing a later reconnect to attest a new PayOS
-- channel identity. The provider projection must follow that replacement.
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
      (
        NEW.status = 'disconnected'
        AND NEW.webhook_status = 'disconnected'
        AND NEW.provider_account_fingerprint IS NULL
        AND NEW.provider_account_verified_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM payment_integrations AS legacy
          WHERE legacy.id = NEW.legacy_payos_integration_id
            AND legacy.shop_id = NEW.shop_id
            AND legacy.provider = 'payos'
            AND legacy.status = 'disconnected'
            AND legacy.webhook_status = 'disconnected'
            AND legacy.active_credential_id IS NULL
            AND legacy.updated_at = NEW.updated_at
        )
      )
      OR (
        OLD.status = 'disconnected'
        AND OLD.webhook_status = 'disconnected'
        AND NEW.status IN ('active', 'degraded')
        AND NEW.provider_account_fingerprint IS NOT NULL
        AND NEW.provider_account_verified_at IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM payment_integrations AS legacy
          WHERE legacy.id = NEW.legacy_payos_integration_id
            AND legacy.shop_id = NEW.shop_id
            AND legacy.provider = 'payos'
            AND legacy.status IN ('active', 'error')
            AND legacy.webhook_status IN ('verified', 'error')
            AND legacy.updated_at = NEW.updated_at
        )
      )
      OR (
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
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_identity_immutable');
END;

-- Keep a tenant-bound history of every verified PayOS account identity. The
-- current integration row may be replaced after an explicit disconnect, but
-- another shop can never claim an identity previously owned by this shop.
CREATE TABLE payos_provider_identity_history (
  provider TEXT NOT NULL CHECK (provider = 'payos'),
  provider_identity_fingerprint TEXT NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES payment_integrations(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_identity_fingerprint),
  UNIQUE (shop_id, provider_identity_fingerprint),
  FOREIGN KEY (shop_id, integration_id)
    REFERENCES payment_integrations(shop_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_payos_provider_identity_history_shop
  ON payos_provider_identity_history(shop_id, last_seen_at DESC, provider_identity_fingerprint);

INSERT OR IGNORE INTO payos_provider_identity_history (
  provider, provider_identity_fingerprint, shop_id, integration_id,
  first_seen_at, last_seen_at
)
SELECT 'payos', provider_identity_fingerprint, shop_id, id,
  COALESCE(connected_at, created_at), updated_at
FROM payment_integrations
WHERE provider = 'payos'
  AND provider_identity_fingerprint IS NOT NULL
  AND (
    (status = 'active' AND webhook_status = 'verified')
    OR (status = 'disconnected' AND last_webhook_verified_at IS NOT NULL)
  );

CREATE TRIGGER payment_integrations_payos_identity_history_insert
AFTER INSERT ON payment_integrations
WHEN NEW.provider = 'payos'
  AND NEW.provider_identity_fingerprint IS NOT NULL
  AND NEW.status = 'active'
  AND NEW.webhook_status = 'verified'
BEGIN
  INSERT INTO payos_provider_identity_history (
    provider, provider_identity_fingerprint, shop_id, integration_id,
    first_seen_at, last_seen_at
  ) VALUES (
    'payos', NEW.provider_identity_fingerprint, NEW.shop_id, NEW.id,
    NEW.created_at, NEW.updated_at
  )
  ON CONFLICT(provider, provider_identity_fingerprint) DO UPDATE SET
    last_seen_at = excluded.last_seen_at;
END;

CREATE TRIGGER payment_integrations_payos_identity_history_update
AFTER UPDATE OF provider_identity_fingerprint ON payment_integrations
WHEN NEW.provider = 'payos'
  AND NEW.provider_identity_fingerprint IS NOT NULL
  AND NEW.status = 'active'
  AND NEW.webhook_status = 'verified'
BEGIN
  INSERT INTO payos_provider_identity_history (
    provider, provider_identity_fingerprint, shop_id, integration_id,
    first_seen_at, last_seen_at
  ) VALUES (
    'payos', NEW.provider_identity_fingerprint, NEW.shop_id, NEW.id,
    NEW.updated_at, NEW.updated_at
  )
  ON CONFLICT(provider, provider_identity_fingerprint) DO UPDATE SET
    last_seen_at = excluded.last_seen_at;
END;
