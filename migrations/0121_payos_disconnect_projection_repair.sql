PRAGMA foreign_keys = ON;

-- Disconnects completed before the provider projection lifecycle migration
-- could retain an account fingerprint on an otherwise disconnected row.
-- Clear only that stale PayOS projection state; the legacy integration remains
-- authoritative and the 0120 identity trigger validates the timestamp fence.
UPDATE payment_provider_connections
SET provider_account_fingerprint = NULL,
  provider_account_verified_at = NULL,
  updated_at = (
    SELECT legacy.updated_at
    FROM payment_integrations AS legacy
    WHERE legacy.id = payment_provider_connections.legacy_payos_integration_id
      AND legacy.shop_id = payment_provider_connections.shop_id
      AND legacy.provider = 'payos'
      AND legacy.status = 'disconnected'
      AND legacy.webhook_status = 'disconnected'
      AND legacy.active_credential_id IS NULL
  ),
  version = version + 1
WHERE provider_code = 'payos'
  AND legacy_payos_integration_id IS NOT NULL
  AND status = 'disconnected'
  AND webhook_status = 'disconnected'
  AND provider_attested_country_code IS NULL
  AND provider_country_attested_at IS NULL
  AND (provider_account_fingerprint IS NOT NULL
    OR provider_account_verified_at IS NOT NULL)
  AND EXISTS (
    SELECT 1
    FROM payment_integrations AS legacy
    WHERE legacy.id = payment_provider_connections.legacy_payos_integration_id
      AND legacy.shop_id = payment_provider_connections.shop_id
      AND legacy.provider = 'payos'
      AND legacy.status = 'disconnected'
      AND legacy.webhook_status = 'disconnected'
      AND legacy.active_credential_id IS NULL
  );
