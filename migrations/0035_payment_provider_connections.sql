PRAGMA foreign_keys = ON;

-- Keep the payment projection provider-neutral without rebuilding the legacy
-- PayOS tables. These registries are deliberately additive so a future
-- provider can extend the supported set with another forward migration.
CREATE TABLE iso_4217_currency_codes (
  code TEXT PRIMARY KEY NOT NULL CHECK (
    length(code) = 3
    AND code = upper(code)
    AND code GLOB '[A-Z][A-Z][A-Z]'
  ),
  minor_unit INTEGER NOT NULL CHECK (minor_unit BETWEEN 0 AND 4)
) WITHOUT ROWID, STRICT;

INSERT INTO iso_4217_currency_codes (code, minor_unit) VALUES
  ('USD', 2),
  ('EUR', 2),
  ('JPY', 0),
  ('VND', 0);

CREATE TRIGGER iso_4217_currency_codes_immutable_update
BEFORE UPDATE ON iso_4217_currency_codes
BEGIN
  SELECT RAISE(ABORT, 'iso_currency_codes_immutable');
END;

CREATE TRIGGER iso_4217_currency_codes_immutable_delete
BEFORE DELETE ON iso_4217_currency_codes
BEGIN
  SELECT RAISE(ABORT, 'iso_currency_codes_immutable');
END;

CREATE TABLE payment_method_codes (
  code TEXT PRIMARY KEY NOT NULL CHECK (
    length(code) BETWEEN 3 AND 64
    AND substr(code, 1, 1) GLOB '[a-z]'
    AND code NOT GLOB '*[^a-z0-9._-]*'
  )
) WITHOUT ROWID, STRICT;

INSERT INTO payment_method_codes (code) VALUES
  ('bank_transfer_qr'),
  ('card'),
  ('wallet'),
  ('native_checkout'),
  ('direct_debit');

CREATE TRIGGER payment_method_codes_immutable_update
BEFORE UPDATE ON payment_method_codes
BEGIN
  SELECT RAISE(ABORT, 'payment_method_codes_immutable');
END;

CREATE TRIGGER payment_method_codes_immutable_delete
BEFORE DELETE ON payment_method_codes
BEGIN
  SELECT RAISE(ABORT, 'payment_method_codes_immutable');
END;

-- This unique parent key lets all child rows enforce tenant identity with a
-- composite foreign key while leaving payment_integrations unchanged.
CREATE UNIQUE INDEX idx_payment_integrations_shop_id
  ON payment_integrations(shop_id, id);

CREATE TABLE payment_provider_connections (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL CHECK (
    length(provider_code) BETWEEN 2 AND 64
    AND substr(provider_code, 1, 1) GLOB '[a-z]'
    AND provider_code NOT GLOB '*[^a-z0-9._-]*'
  ),
  provider_environment TEXT NOT NULL CHECK (provider_environment IN ('unknown', 'sandbox', 'live')),
  provider_descriptor_version INTEGER NOT NULL CHECK (provider_descriptor_version > 0),
  capability_policy_version INTEGER NOT NULL CHECK (capability_policy_version > 0),
  connection_mode TEXT NOT NULL CHECK (connection_mode IN ('bring_your_own', 'managed')),
  settlement_mode TEXT NOT NULL CHECK (settlement_mode IN ('direct', 'mor_partner')),
  credential_ownership TEXT NOT NULL CHECK (credential_ownership IN ('seller', 'platform', 'provider_partner')),
  merchant_country_code TEXT REFERENCES iso_3166_alpha2_country_codes(code) ON DELETE RESTRICT,
  provider_attested_country_code TEXT REFERENCES iso_3166_alpha2_country_codes(code) ON DELETE RESTRICT,
  provider_country_attested_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'degraded', 'disconnected')),
  webhook_status TEXT NOT NULL CHECK (webhook_status IN ('pending', 'verified', 'error', 'disconnected')),
  provider_account_fingerprint TEXT CHECK (
    provider_account_fingerprint IS NULL
    OR (
      length(provider_account_fingerprint) BETWEEN 8 AND 256
      AND provider_account_fingerprint NOT GLOB '*[[:space:]]*'
    )
  ),
  provider_account_verified_at TEXT,
  last_safe_error_code TEXT CHECK (
    last_safe_error_code IS NULL OR length(last_safe_error_code) BETWEEN 3 AND 96
  ),
  last_checked_at TEXT,
  last_webhook_verified_at TEXT,
  connected_at TEXT,
  disconnected_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  legacy_payos_integration_id TEXT UNIQUE,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, legacy_payos_integration_id)
    REFERENCES payment_integrations(shop_id, id) ON DELETE RESTRICT,
  CHECK (
    (connection_mode = 'bring_your_own' AND credential_ownership = 'seller')
    OR (connection_mode = 'managed' AND credential_ownership IN ('platform', 'provider_partner'))
  ),
  CHECK (
    (settlement_mode = 'direct' AND credential_ownership IN ('seller', 'platform'))
    OR (settlement_mode = 'mor_partner' AND credential_ownership = 'provider_partner')
  ),
  CHECK (legacy_payos_integration_id IS NOT NULL OR provider_environment != 'unknown'),
  CHECK ((provider_attested_country_code IS NULL) = (provider_country_attested_at IS NULL)),
  CHECK ((provider_account_fingerprint IS NULL) = (provider_account_verified_at IS NULL)),
  CHECK (
    provider_account_fingerprint IS NULL
    OR (
      status IN ('active', 'degraded', 'disconnected')
      AND webhook_status IN ('verified', 'disconnected')
    )
  )
) STRICT;

CREATE INDEX idx_payment_provider_connections_shop_status
  ON payment_provider_connections(shop_id, status, updated_at DESC, id);

CREATE INDEX idx_payment_provider_connections_shop_provider
  ON payment_provider_connections(shop_id, provider_code, status, id);

-- Only authenticated live identities hold durable ownership. A pending or
-- webhook-unverified fingerprint is evidence but cannot squat an identity;
-- disconnected rows remain as audit evidence and may be replaced later.
CREATE UNIQUE INDEX idx_payment_provider_connections_live_identity
  ON payment_provider_connections(provider_code, provider_environment, provider_account_fingerprint)
  WHERE provider_account_fingerprint IS NOT NULL
    AND status IN ('active', 'degraded')
    AND webhook_status = 'verified';

CREATE TRIGGER payment_provider_connections_merchant_country_guard
BEFORE INSERT ON payment_provider_connections
WHEN NEW.merchant_country_code IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shops
    WHERE shops.id = NEW.shop_id
      AND shops.merchant_country_code = NEW.merchant_country_code
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_merchant_country_mismatch');
END;

CREATE TRIGGER payment_provider_connections_merchant_country_update_guard
BEFORE UPDATE OF shop_id, merchant_country_code ON payment_provider_connections
WHEN NEW.merchant_country_code IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shops
    WHERE shops.id = NEW.shop_id
      AND shops.merchant_country_code = NEW.merchant_country_code
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_merchant_country_mismatch');
END;

CREATE TRIGGER payment_provider_connections_legacy_link_guard
BEFORE INSERT ON payment_provider_connections
WHEN NEW.legacy_payos_integration_id IS NOT NULL
  AND (
    NEW.provider_code != 'payos'
    OR NOT EXISTS (
      SELECT 1
      FROM payment_integrations
      WHERE payment_integrations.shop_id = NEW.shop_id
        AND payment_integrations.id = NEW.legacy_payos_integration_id
        AND payment_integrations.provider = 'payos'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_legacy_link_invalid');
END;

CREATE TRIGGER payment_provider_connections_legacy_link_update_guard
BEFORE UPDATE OF shop_id, provider_code, legacy_payos_integration_id
ON payment_provider_connections
WHEN NEW.legacy_payos_integration_id IS NOT NULL
  AND (
    NEW.provider_code != 'payos'
    OR NOT EXISTS (
      SELECT 1
      FROM payment_integrations
      WHERE payment_integrations.shop_id = NEW.shop_id
        AND payment_integrations.id = NEW.legacy_payos_integration_id
        AND payment_integrations.provider = 'payos'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_legacy_link_invalid');
END;

-- Provider and tenant identity are evidence, not mutable display settings.
-- A connection may fill provider-attested identity once verification succeeds,
-- but it cannot be reassigned after the attestation is known.
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
  OR (OLD.provider_attested_country_code IS NOT NULL
    AND NEW.provider_attested_country_code IS NOT OLD.provider_attested_country_code)
  OR (OLD.provider_country_attested_at IS NOT NULL
    AND NEW.provider_country_attested_at IS NOT OLD.provider_country_attested_at)
  OR (OLD.provider_account_fingerprint IS NOT NULL
    AND NEW.provider_account_fingerprint IS NOT OLD.provider_account_fingerprint)
  OR (OLD.provider_account_verified_at IS NOT NULL
    AND NEW.provider_account_verified_at IS NOT OLD.provider_account_verified_at)
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_identity_immutable');
END;

CREATE TRIGGER payment_provider_connections_status_transition_guard
BEFORE UPDATE OF status ON payment_provider_connections
WHEN NOT (
  (OLD.status = 'pending' AND NEW.status IN ('pending', 'active', 'degraded', 'disconnected'))
  OR (OLD.status = 'active' AND NEW.status IN ('active', 'degraded', 'disconnected'))
  OR (OLD.status = 'degraded' AND NEW.status IN ('active', 'degraded', 'disconnected'))
  OR (OLD.status = 'disconnected' AND NEW.status = 'disconnected')
)
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_status_transition_invalid');
END;

CREATE TRIGGER payment_provider_connections_webhook_transition_guard
BEFORE UPDATE OF webhook_status ON payment_provider_connections
WHEN NOT (
  (OLD.webhook_status = 'pending' AND NEW.webhook_status IN ('pending', 'verified', 'error', 'disconnected'))
  OR (OLD.webhook_status = 'verified' AND NEW.webhook_status IN ('verified', 'error', 'disconnected'))
  OR (OLD.webhook_status = 'error' AND NEW.webhook_status IN ('pending', 'verified', 'error', 'disconnected'))
  OR (OLD.webhook_status = 'disconnected' AND NEW.webhook_status = 'disconnected')
)
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_webhook_transition_invalid');
END;

CREATE TABLE payment_provider_connection_capabilities (
  shop_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  capability_code TEXT NOT NULL CHECK (
    capability_code IN (
      'checkout.create', 'credential.health', 'payment.reconcile',
      'refund.create', 'webhook.verify'
    )
  ),
  provider_granted INTEGER NOT NULL CHECK (provider_granted IN (0, 1)),
  effective_enabled INTEGER NOT NULL CHECK (effective_enabled IN (0, 1)),
  provider_descriptor_version INTEGER NOT NULL CHECK (provider_descriptor_version > 0),
  capability_policy_version INTEGER NOT NULL CHECK (capability_policy_version > 0),
  evidence_reference TEXT CHECK (
    evidence_reference IS NULL
    OR (length(evidence_reference) BETWEEN 3 AND 256 AND evidence_reference NOT GLOB '*[[:space:]]*')
  ),
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, connection_id, capability_code),
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES payment_provider_connections(shop_id, id) ON DELETE CASCADE,
  CHECK (effective_enabled = 0 OR provider_granted = 1),
  CHECK (effective_enabled = 0 OR revoked_at IS NULL)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_payment_provider_connection_capabilities_shop_effective
  ON payment_provider_connection_capabilities(shop_id, effective_enabled, capability_code, connection_id);

CREATE TRIGGER payment_provider_connection_capabilities_identity_immutable
BEFORE UPDATE ON payment_provider_connection_capabilities
WHEN NEW.shop_id != OLD.shop_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.capability_code != OLD.capability_code
  OR NEW.granted_at != OLD.granted_at
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_capability_identity_immutable');
END;

CREATE TABLE payment_provider_connection_currencies (
  shop_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES iso_4217_currency_codes(code) ON DELETE RESTRICT,
  provider_supported INTEGER NOT NULL CHECK (provider_supported IN (0, 1)),
  effective_enabled INTEGER NOT NULL CHECK (effective_enabled IN (0, 1)),
  provider_descriptor_version INTEGER NOT NULL CHECK (provider_descriptor_version > 0),
  capability_policy_version INTEGER NOT NULL CHECK (capability_policy_version > 0),
  evidence_reference TEXT CHECK (
    evidence_reference IS NULL
    OR (length(evidence_reference) BETWEEN 3 AND 256 AND evidence_reference NOT GLOB '*[[:space:]]*')
  ),
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, connection_id, currency_code),
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES payment_provider_connections(shop_id, id) ON DELETE CASCADE,
  CHECK (effective_enabled = 0 OR provider_supported = 1)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_payment_provider_connection_currencies_shop_effective
  ON payment_provider_connection_currencies(shop_id, effective_enabled, currency_code, connection_id);

CREATE TABLE payment_provider_connection_methods (
  shop_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  method_code TEXT NOT NULL REFERENCES payment_method_codes(code) ON DELETE RESTRICT,
  provider_supported INTEGER NOT NULL CHECK (provider_supported IN (0, 1)),
  effective_enabled INTEGER NOT NULL CHECK (effective_enabled IN (0, 1)),
  provider_descriptor_version INTEGER NOT NULL CHECK (provider_descriptor_version > 0),
  capability_policy_version INTEGER NOT NULL CHECK (capability_policy_version > 0),
  evidence_reference TEXT CHECK (
    evidence_reference IS NULL
    OR (length(evidence_reference) BETWEEN 3 AND 256 AND evidence_reference NOT GLOB '*[[:space:]]*')
  ),
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, connection_id, method_code),
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES payment_provider_connections(shop_id, id) ON DELETE CASCADE,
  CHECK (effective_enabled = 0 OR provider_supported = 1)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_payment_provider_connection_methods_shop_effective
  ON payment_provider_connection_methods(shop_id, effective_enabled, method_code, connection_id);

CREATE TRIGGER payment_provider_capabilities_effective_insert_guard
BEFORE INSERT ON payment_provider_connection_capabilities
WHEN NEW.effective_enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM payment_provider_connections
    WHERE payment_provider_connections.shop_id = NEW.shop_id
      AND payment_provider_connections.id = NEW.connection_id
      AND payment_provider_connections.status = 'active'
      AND payment_provider_connections.webhook_status = 'verified'
      AND payment_provider_connections.provider_account_fingerprint IS NOT NULL
      AND payment_provider_connections.provider_descriptor_version = NEW.provider_descriptor_version
      AND payment_provider_connections.capability_policy_version = NEW.capability_policy_version
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_capability_connection_ineligible');
END;

CREATE TRIGGER payment_provider_capabilities_effective_update_guard
BEFORE UPDATE OF shop_id, connection_id, effective_enabled,
  provider_descriptor_version, capability_policy_version
ON payment_provider_connection_capabilities
WHEN NEW.effective_enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM payment_provider_connections
    WHERE payment_provider_connections.shop_id = NEW.shop_id
      AND payment_provider_connections.id = NEW.connection_id
      AND payment_provider_connections.status = 'active'
      AND payment_provider_connections.webhook_status = 'verified'
      AND payment_provider_connections.provider_account_fingerprint IS NOT NULL
      AND payment_provider_connections.provider_descriptor_version = NEW.provider_descriptor_version
      AND payment_provider_connections.capability_policy_version = NEW.capability_policy_version
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_capability_connection_ineligible');
END;

CREATE TRIGGER payment_provider_currencies_effective_insert_guard
BEFORE INSERT ON payment_provider_connection_currencies
WHEN NEW.effective_enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM payment_provider_connections
    WHERE payment_provider_connections.shop_id = NEW.shop_id
      AND payment_provider_connections.id = NEW.connection_id
      AND payment_provider_connections.status = 'active'
      AND payment_provider_connections.webhook_status = 'verified'
      AND payment_provider_connections.provider_account_fingerprint IS NOT NULL
      AND payment_provider_connections.provider_descriptor_version = NEW.provider_descriptor_version
      AND payment_provider_connections.capability_policy_version = NEW.capability_policy_version
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_currency_connection_ineligible');
END;

CREATE TRIGGER payment_provider_currencies_effective_update_guard
BEFORE UPDATE OF shop_id, connection_id, effective_enabled,
  provider_descriptor_version, capability_policy_version
ON payment_provider_connection_currencies
WHEN NEW.effective_enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM payment_provider_connections
    WHERE payment_provider_connections.shop_id = NEW.shop_id
      AND payment_provider_connections.id = NEW.connection_id
      AND payment_provider_connections.status = 'active'
      AND payment_provider_connections.webhook_status = 'verified'
      AND payment_provider_connections.provider_account_fingerprint IS NOT NULL
      AND payment_provider_connections.provider_descriptor_version = NEW.provider_descriptor_version
      AND payment_provider_connections.capability_policy_version = NEW.capability_policy_version
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_currency_connection_ineligible');
END;

CREATE TRIGGER payment_provider_methods_effective_insert_guard
BEFORE INSERT ON payment_provider_connection_methods
WHEN NEW.effective_enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM payment_provider_connections
    WHERE payment_provider_connections.shop_id = NEW.shop_id
      AND payment_provider_connections.id = NEW.connection_id
      AND payment_provider_connections.status = 'active'
      AND payment_provider_connections.webhook_status = 'verified'
      AND payment_provider_connections.provider_account_fingerprint IS NOT NULL
      AND payment_provider_connections.provider_descriptor_version = NEW.provider_descriptor_version
      AND payment_provider_connections.capability_policy_version = NEW.capability_policy_version
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_method_connection_ineligible');
END;

CREATE TRIGGER payment_provider_methods_effective_update_guard
BEFORE UPDATE OF shop_id, connection_id, effective_enabled,
  provider_descriptor_version, capability_policy_version
ON payment_provider_connection_methods
WHEN NEW.effective_enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM payment_provider_connections
    WHERE payment_provider_connections.shop_id = NEW.shop_id
      AND payment_provider_connections.id = NEW.connection_id
      AND payment_provider_connections.status = 'active'
      AND payment_provider_connections.webhook_status = 'verified'
      AND payment_provider_connections.provider_account_fingerprint IS NOT NULL
      AND payment_provider_connections.provider_descriptor_version = NEW.provider_descriptor_version
      AND payment_provider_connections.capability_policy_version = NEW.capability_policy_version
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_method_connection_ineligible');
END;

-- Effective projections fail closed whenever health degrades or a descriptor
-- or policy version changes. Re-enabling requires an explicit reevaluation.
CREATE TRIGGER payment_provider_connections_zero_stale_effective_projection
AFTER UPDATE OF status, webhook_status, provider_descriptor_version,
  capability_policy_version ON payment_provider_connections
WHEN NEW.status != 'active'
  OR NEW.webhook_status != 'verified'
  OR NEW.provider_descriptor_version != OLD.provider_descriptor_version
  OR NEW.capability_policy_version != OLD.capability_policy_version
BEGIN
  UPDATE payment_provider_connection_capabilities
  SET effective_enabled = 0, evaluated_at = NEW.updated_at
  WHERE shop_id = NEW.shop_id AND connection_id = NEW.id AND effective_enabled != 0;

  UPDATE payment_provider_connection_currencies
  SET effective_enabled = 0, evaluated_at = NEW.updated_at
  WHERE shop_id = NEW.shop_id AND connection_id = NEW.id AND effective_enabled != 0;

  UPDATE payment_provider_connection_methods
  SET effective_enabled = 0, evaluated_at = NEW.updated_at
  WHERE shop_id = NEW.shop_id AND connection_id = NEW.id AND effective_enabled != 0;
END;

-- Deterministic projection of existing PayOS rows. The legacy tables remain
-- authoritative until an explicit runtime dual-read/write cutover.
INSERT INTO payment_provider_connections (
  id, public_id, shop_id, provider_code, provider_environment,
  provider_descriptor_version, capability_policy_version, connection_mode,
  settlement_mode, credential_ownership, merchant_country_code,
  provider_attested_country_code, provider_country_attested_at,
  status, webhook_status, provider_account_fingerprint,
  provider_account_verified_at,
  last_safe_error_code, last_checked_at, last_webhook_verified_at,
  connected_at, disconnected_at, version, created_at, updated_at,
  legacy_payos_integration_id
)
SELECT
  pi.id,
  pi.public_id,
  pi.shop_id,
  pi.provider,
  'unknown',
  1,
  1,
  'bring_your_own',
  'direct',
  'seller',
  shops.merchant_country_code,
  NULL,
  NULL,
  CASE pi.status WHEN 'error' THEN 'degraded' ELSE pi.status END,
  pi.webhook_status,
  CASE
    WHEN pi.status = 'active'
      AND pi.webhook_status = 'verified'
    THEN pi.provider_identity_fingerprint
    ELSE NULL
  END,
  CASE
    WHEN pi.status = 'active'
      AND pi.webhook_status = 'verified'
      AND pi.provider_identity_fingerprint IS NOT NULL
    THEN COALESCE(
      pi.last_webhook_verified_at, pi.last_checked_at, pi.connected_at, pi.updated_at
    )
    ELSE NULL
  END,
  pi.last_safe_error_code,
  pi.last_checked_at,
  pi.last_webhook_verified_at,
  pi.connected_at,
  CASE WHEN pi.status = 'disconnected' THEN pi.updated_at ELSE NULL END,
  1,
  pi.created_at,
  pi.updated_at,
  pi.id
FROM payment_integrations AS pi
INNER JOIN shops ON shops.id = pi.shop_id
WHERE pi.provider = 'payos';

INSERT INTO payment_provider_connection_capabilities (
  shop_id, connection_id, capability_code, provider_granted, effective_enabled,
  provider_descriptor_version, capability_policy_version, evidence_reference,
  granted_at, evaluated_at
)
SELECT
  connection.shop_id,
  connection.id,
  capability.code,
  1,
  CASE WHEN connection.status = 'active'
      AND connection.webhook_status = 'verified'
      AND connection.provider_account_fingerprint IS NOT NULL THEN 1 ELSE 0 END,
  connection.provider_descriptor_version,
  connection.capability_policy_version,
  'legacy:payment_integration:' || connection.legacy_payos_integration_id,
  connection.created_at,
  connection.updated_at
FROM payment_provider_connections AS connection
CROSS JOIN (
  SELECT 'checkout.create' AS code
  UNION ALL SELECT 'credential.health'
  UNION ALL SELECT 'payment.reconcile'
  UNION ALL SELECT 'webhook.verify'
) AS capability
WHERE connection.provider_code = 'payos';

INSERT INTO payment_provider_connection_currencies (
  shop_id, connection_id, currency_code, provider_supported, effective_enabled,
  provider_descriptor_version, capability_policy_version, evidence_reference,
  evaluated_at
)
SELECT
  connection.shop_id,
  connection.id,
  'VND',
  1,
  CASE WHEN connection.status = 'active'
      AND connection.webhook_status = 'verified'
      AND connection.provider_account_fingerprint IS NOT NULL THEN 1 ELSE 0 END,
  connection.provider_descriptor_version,
  connection.capability_policy_version,
  'legacy:payment_integration:' || connection.legacy_payos_integration_id,
  connection.updated_at
FROM payment_provider_connections AS connection
WHERE connection.provider_code = 'payos';

INSERT INTO payment_provider_connection_methods (
  shop_id, connection_id, method_code, provider_supported, effective_enabled,
  provider_descriptor_version, capability_policy_version, evidence_reference,
  evaluated_at
)
SELECT
  connection.shop_id,
  connection.id,
  'bank_transfer_qr',
  1,
  CASE WHEN connection.status = 'active'
      AND connection.webhook_status = 'verified'
      AND connection.provider_account_fingerprint IS NOT NULL THEN 1 ELSE 0 END,
  connection.provider_descriptor_version,
  connection.capability_policy_version,
  'legacy:payment_integration:' || connection.legacy_payos_integration_id,
  connection.updated_at
FROM payment_provider_connections AS connection
WHERE connection.provider_code = 'payos';
