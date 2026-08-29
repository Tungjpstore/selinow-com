PRAGMA foreign_keys = ON;

-- A failed reconnect can leave a disconnected integration quarantined with a
-- stale claim target. Release only that non-active claim so the next owner
-- initiated reconnect can establish a fresh webhook target.
UPDATE payment_credentials
SET provider_claim_nonce = NULL
WHERE provider = 'payos'
  AND status IN ('pending', 'error')
  AND provider_claim_nonce IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM payment_integrations AS integration
    WHERE integration.id = payment_credentials.integration_id
      AND integration.shop_id = payment_credentials.shop_id
      AND integration.provider = 'payos'
      AND integration.status = 'disconnected'
      AND integration.webhook_status = 'disconnected'
      AND integration.active_credential_id IS NULL
      AND integration.provider_claim_state = 'quarantined'
      AND integration.provider_claim_nonce = payment_credentials.provider_claim_nonce
  );

UPDATE payment_integrations
SET provider_claim_nonce = NULL,
  provider_claim_state = 'idle',
  provider_claim_target_fingerprint = NULL,
  updated_at = updated_at
WHERE provider = 'payos'
  AND status = 'disconnected'
  AND webhook_status = 'disconnected'
  AND active_credential_id IS NULL
  AND provider_claim_state = 'quarantined'
  AND provider_claim_nonce IS NOT NULL;
