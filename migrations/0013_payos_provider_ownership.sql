PRAGMA foreign_keys = ON;

ALTER TABLE payment_integrations ADD COLUMN provider_identity_fingerprint TEXT;

ALTER TABLE payment_credentials ADD COLUMN provider_ownership_fingerprint TEXT;

CREATE UNIQUE INDEX idx_payment_integrations_provider_identity
  ON payment_integrations(provider, provider_identity_fingerprint)
  WHERE provider_identity_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX idx_payment_credentials_provider_ownership
  ON payment_credentials(provider, provider_ownership_fingerprint)
  WHERE provider_ownership_fingerprint IS NOT NULL
    AND status IN ('pending', 'active', 'grace', 'error');
