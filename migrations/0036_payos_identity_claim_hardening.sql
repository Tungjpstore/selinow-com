PRAGMA foreign_keys = ON;

-- Older connection attempts claimed the client-id fingerprint before PayOS
-- confirmed the credentials. Release only those unverified claims; verified
-- or disconnected integrations retain ownership for safe reconnect behavior.
UPDATE payment_integrations
SET provider_identity_fingerprint = NULL
WHERE provider = 'payos'
  AND active_credential_id IS NULL
  AND status IN ('pending', 'error')
  AND provider_identity_fingerprint IS NOT NULL;

-- The legacy credential ownership fingerprint was also written before
-- provider confirmation. Clear only unverified lifecycle rows; active and
-- grace credentials remain eligible for in-flight reconciliation.
UPDATE payment_credentials
SET provider_ownership_fingerprint = NULL
WHERE provider = 'payos'
  AND status IN ('pending', 'error')
  AND provider_ownership_fingerprint IS NOT NULL;
