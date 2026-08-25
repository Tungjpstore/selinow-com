PRAGMA foreign_keys = ON;

-- The provider-neutral tables were introduced as a deterministic projection
-- of the legacy PayOS authority. Keep that bridge complete for integrations
-- created after migration 0035, including Workers from the previous release.

DROP TRIGGER IF EXISTS payment_provider_connections_status_transition_guard;

CREATE TRIGGER payment_provider_connections_status_transition_guard
BEFORE UPDATE OF status ON payment_provider_connections
WHEN NOT (
  (OLD.status = 'pending' AND NEW.status IN ('pending', 'active', 'degraded', 'disconnected'))
  OR (OLD.status = 'active' AND NEW.status IN ('active', 'degraded', 'disconnected'))
  OR (OLD.status = 'degraded' AND NEW.status IN ('active', 'degraded', 'disconnected'))
  OR (OLD.status = 'disconnected' AND NEW.status = 'disconnected')
  OR (
    OLD.status = 'disconnected'
    AND NEW.status IN ('active', 'degraded')
    AND NEW.legacy_payos_integration_id IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_status_transition_invalid');
END;

DROP TRIGGER IF EXISTS payment_provider_connections_webhook_transition_guard;

CREATE TRIGGER payment_provider_connections_webhook_transition_guard
BEFORE UPDATE OF webhook_status ON payment_provider_connections
WHEN NOT (
  (OLD.webhook_status = 'pending' AND NEW.webhook_status IN ('pending', 'verified', 'error', 'disconnected'))
  OR (OLD.webhook_status = 'verified' AND NEW.webhook_status IN ('verified', 'error', 'disconnected'))
  OR (OLD.webhook_status = 'error' AND NEW.webhook_status IN ('pending', 'verified', 'error', 'disconnected'))
  OR (OLD.webhook_status = 'disconnected' AND NEW.webhook_status = 'disconnected')
  OR (
    OLD.webhook_status = 'disconnected'
    AND NEW.webhook_status IN ('verified', 'error')
    AND NEW.legacy_payos_integration_id IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_provider_connection_webhook_transition_invalid');
END;

INSERT INTO payment_provider_connections (
  id, public_id, shop_id, provider_code, provider_environment,
  provider_descriptor_version, capability_policy_version, connection_mode,
  settlement_mode, credential_ownership, merchant_country_code,
  provider_attested_country_code, provider_country_attested_at,
  status, webhook_status, provider_account_fingerprint,
  provider_account_verified_at, last_safe_error_code, last_checked_at,
  last_webhook_verified_at, connected_at, disconnected_at, version,
  created_at, updated_at, legacy_payos_integration_id
)
SELECT
  integration.id,
  integration.public_id,
  integration.shop_id,
  'payos',
  'unknown',
  1,
  1,
  'bring_your_own',
  'direct',
  'seller',
  shop.merchant_country_code,
  NULL,
  NULL,
  CASE integration.status WHEN 'error' THEN 'degraded' ELSE integration.status END,
  integration.webhook_status,
  CASE
    WHEN integration.status = 'active'
      AND integration.webhook_status = 'verified'
    THEN integration.provider_identity_fingerprint
    ELSE NULL
  END,
  CASE
    WHEN integration.status = 'active'
      AND integration.webhook_status = 'verified'
      AND integration.provider_identity_fingerprint IS NOT NULL
    THEN COALESCE(
      integration.last_webhook_verified_at,
      integration.last_checked_at,
      integration.connected_at,
      integration.updated_at
    )
    ELSE NULL
  END,
  integration.last_safe_error_code,
  integration.last_checked_at,
  integration.last_webhook_verified_at,
  integration.connected_at,
  CASE WHEN integration.status = 'disconnected' THEN integration.updated_at ELSE NULL END,
  1,
  integration.created_at,
  integration.updated_at,
  integration.id
FROM payment_integrations AS integration
INNER JOIN shops AS shop ON shop.id = integration.shop_id
WHERE integration.provider = 'payos'
  AND NOT EXISTS (
    SELECT 1
    FROM payment_provider_connections AS connection
    WHERE connection.shop_id = integration.shop_id
      AND connection.legacy_payos_integration_id = integration.id
  );

INSERT OR IGNORE INTO payment_provider_connection_capabilities (
  shop_id, connection_id, capability_code, provider_granted,
  effective_enabled, provider_descriptor_version, capability_policy_version,
  evidence_reference, granted_at, evaluated_at
)
SELECT
  connection.shop_id,
  connection.id,
  capability.code,
  1,
  CASE
    WHEN connection.status = 'active'
      AND connection.webhook_status = 'verified'
      AND connection.provider_account_fingerprint IS NOT NULL
    THEN 1 ELSE 0
  END,
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
WHERE connection.provider_code = 'payos'
  AND connection.legacy_payos_integration_id IS NOT NULL;

INSERT OR IGNORE INTO payment_provider_connection_currencies (
  shop_id, connection_id, currency_code, provider_supported,
  effective_enabled, provider_descriptor_version, capability_policy_version,
  evidence_reference, evaluated_at
)
SELECT
  connection.shop_id,
  connection.id,
  'VND',
  1,
  CASE
    WHEN connection.status = 'active'
      AND connection.webhook_status = 'verified'
      AND connection.provider_account_fingerprint IS NOT NULL
    THEN 1 ELSE 0
  END,
  connection.provider_descriptor_version,
  connection.capability_policy_version,
  'legacy:payment_integration:' || connection.legacy_payos_integration_id,
  connection.updated_at
FROM payment_provider_connections AS connection
WHERE connection.provider_code = 'payos'
  AND connection.legacy_payos_integration_id IS NOT NULL;

INSERT OR IGNORE INTO payment_provider_connection_methods (
  shop_id, connection_id, method_code, provider_supported,
  effective_enabled, provider_descriptor_version, capability_policy_version,
  evidence_reference, evaluated_at
)
SELECT
  connection.shop_id,
  connection.id,
  'bank_transfer_qr',
  1,
  CASE
    WHEN connection.status = 'active'
      AND connection.webhook_status = 'verified'
      AND connection.provider_account_fingerprint IS NOT NULL
    THEN 1 ELSE 0
  END,
  connection.provider_descriptor_version,
  connection.capability_policy_version,
  'legacy:payment_integration:' || connection.legacy_payos_integration_id,
  connection.updated_at
FROM payment_provider_connections AS connection
WHERE connection.provider_code = 'payos'
  AND connection.legacy_payos_integration_id IS NOT NULL;

CREATE TRIGGER payment_integrations_payos_projection_insert
AFTER INSERT ON payment_integrations
WHEN NEW.provider = 'payos'
BEGIN
  INSERT INTO payment_provider_connections (
    id, public_id, shop_id, provider_code, provider_environment,
    provider_descriptor_version, capability_policy_version, connection_mode,
    settlement_mode, credential_ownership, merchant_country_code,
    status, webhook_status, provider_account_fingerprint,
    provider_account_verified_at, last_safe_error_code, last_checked_at,
    last_webhook_verified_at, connected_at, disconnected_at, version,
    created_at, updated_at, legacy_payos_integration_id
  )
  SELECT
    NEW.id,
    NEW.public_id,
    NEW.shop_id,
    'payos',
    'unknown',
    1,
    1,
    'bring_your_own',
    'direct',
    'seller',
    shop.merchant_country_code,
    CASE NEW.status WHEN 'error' THEN 'degraded' ELSE NEW.status END,
    NEW.webhook_status,
    CASE
      WHEN NEW.status = 'active' AND NEW.webhook_status = 'verified'
      THEN NEW.provider_identity_fingerprint ELSE NULL
    END,
    CASE
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN COALESCE(
        NEW.last_webhook_verified_at,
        NEW.last_checked_at,
        NEW.connected_at,
        NEW.updated_at
      )
      ELSE NULL
    END,
    NEW.last_safe_error_code,
    NEW.last_checked_at,
    NEW.last_webhook_verified_at,
    NEW.connected_at,
    CASE WHEN NEW.status = 'disconnected' THEN NEW.updated_at ELSE NULL END,
    1,
    NEW.created_at,
    NEW.updated_at,
    NEW.id
  FROM shops AS shop
  WHERE shop.id = NEW.shop_id;

  INSERT INTO payment_provider_connection_capabilities (
    shop_id, connection_id, capability_code, provider_granted,
    effective_enabled, provider_descriptor_version, capability_policy_version,
    evidence_reference, granted_at, evaluated_at
  )
  SELECT
    NEW.shop_id,
    NEW.id,
    capability.code,
    1,
    CASE
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN 1 ELSE 0
    END,
    1,
    1,
    'legacy:payment_integration:' || NEW.id,
    NEW.created_at,
    NEW.updated_at
  FROM (
    SELECT 'checkout.create' AS code
    UNION ALL SELECT 'credential.health'
    UNION ALL SELECT 'payment.reconcile'
    UNION ALL SELECT 'webhook.verify'
  ) AS capability;

  INSERT INTO payment_provider_connection_currencies (
    shop_id, connection_id, currency_code, provider_supported,
    effective_enabled, provider_descriptor_version, capability_policy_version,
    evidence_reference, evaluated_at
  ) VALUES (
    NEW.shop_id,
    NEW.id,
    'VND',
    1,
    CASE
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN 1 ELSE 0
    END,
    1,
    1,
    'legacy:payment_integration:' || NEW.id,
    NEW.updated_at
  );

  INSERT INTO payment_provider_connection_methods (
    shop_id, connection_id, method_code, provider_supported,
    effective_enabled, provider_descriptor_version, capability_policy_version,
    evidence_reference, evaluated_at
  ) VALUES (
    NEW.shop_id,
    NEW.id,
    'bank_transfer_qr',
    1,
    CASE
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN 1 ELSE 0
    END,
    1,
    1,
    'legacy:payment_integration:' || NEW.id,
    NEW.updated_at
  );
END;

CREATE TRIGGER payment_integrations_payos_projection_update
AFTER UPDATE OF status, webhook_status, provider_identity_fingerprint,
  last_safe_error_code, last_checked_at, last_webhook_verified_at,
  connected_at, updated_at
ON payment_integrations
WHEN NEW.provider = 'payos'
BEGIN
  INSERT INTO payment_provider_connections (
    id, public_id, shop_id, provider_code, provider_environment,
    provider_descriptor_version, capability_policy_version, connection_mode,
    settlement_mode, credential_ownership, merchant_country_code,
    status, webhook_status, provider_account_fingerprint,
    provider_account_verified_at, last_safe_error_code, last_checked_at,
    last_webhook_verified_at, connected_at, disconnected_at, version,
    created_at, updated_at, legacy_payos_integration_id
  )
  SELECT
    NEW.id,
    NEW.public_id,
    NEW.shop_id,
    'payos',
    'unknown',
    1,
    1,
    'bring_your_own',
    'direct',
    'seller',
    shop.merchant_country_code,
    CASE NEW.status WHEN 'error' THEN 'degraded' ELSE NEW.status END,
    NEW.webhook_status,
    CASE
      WHEN NEW.status = 'active' AND NEW.webhook_status = 'verified'
      THEN NEW.provider_identity_fingerprint ELSE NULL
    END,
    CASE
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN COALESCE(
        NEW.last_webhook_verified_at,
        NEW.last_checked_at,
        NEW.connected_at,
        NEW.updated_at
      )
      ELSE NULL
    END,
    NEW.last_safe_error_code,
    NEW.last_checked_at,
    NEW.last_webhook_verified_at,
    NEW.connected_at,
    CASE WHEN NEW.status = 'disconnected' THEN NEW.updated_at ELSE NULL END,
    1,
    NEW.created_at,
    NEW.updated_at,
    NEW.id
  FROM shops AS shop
  WHERE shop.id = NEW.shop_id
    AND NOT EXISTS (
      SELECT 1
      FROM payment_provider_connections AS connection
      WHERE connection.shop_id = NEW.shop_id
        AND connection.legacy_payos_integration_id = NEW.id
    );

  INSERT OR IGNORE INTO payment_provider_connection_capabilities (
    shop_id, connection_id, capability_code, provider_granted,
    effective_enabled, provider_descriptor_version, capability_policy_version,
    evidence_reference, granted_at, evaluated_at
  )
  SELECT
    connection.shop_id,
    connection.id,
    capability.code,
    1,
    0,
    connection.provider_descriptor_version,
    connection.capability_policy_version,
    'legacy:payment_integration:' || NEW.id,
    connection.created_at,
    NEW.updated_at
  FROM payment_provider_connections AS connection
  CROSS JOIN (
    SELECT 'checkout.create' AS code
    UNION ALL SELECT 'credential.health'
    UNION ALL SELECT 'payment.reconcile'
    UNION ALL SELECT 'webhook.verify'
  ) AS capability
  WHERE connection.shop_id = NEW.shop_id
    AND connection.legacy_payos_integration_id = NEW.id;

  INSERT OR IGNORE INTO payment_provider_connection_currencies (
    shop_id, connection_id, currency_code, provider_supported,
    effective_enabled, provider_descriptor_version, capability_policy_version,
    evidence_reference, evaluated_at
  )
  SELECT
    connection.shop_id,
    connection.id,
    'VND',
    1,
    0,
    connection.provider_descriptor_version,
    connection.capability_policy_version,
    'legacy:payment_integration:' || NEW.id,
    NEW.updated_at
  FROM payment_provider_connections AS connection
  WHERE connection.shop_id = NEW.shop_id
    AND connection.legacy_payos_integration_id = NEW.id;

  INSERT OR IGNORE INTO payment_provider_connection_methods (
    shop_id, connection_id, method_code, provider_supported,
    effective_enabled, provider_descriptor_version, capability_policy_version,
    evidence_reference, evaluated_at
  )
  SELECT
    connection.shop_id,
    connection.id,
    'bank_transfer_qr',
    1,
    0,
    connection.provider_descriptor_version,
    connection.capability_policy_version,
    'legacy:payment_integration:' || NEW.id,
    NEW.updated_at
  FROM payment_provider_connections AS connection
  WHERE connection.shop_id = NEW.shop_id
    AND connection.legacy_payos_integration_id = NEW.id;

  UPDATE payment_provider_connections
  SET status = CASE NEW.status WHEN 'error' THEN 'degraded' ELSE NEW.status END,
    webhook_status = CASE
      WHEN NEW.status = 'error'
        AND provider_account_fingerprint IS NOT NULL
      THEN 'verified'
      ELSE NEW.webhook_status
    END,
    provider_account_fingerprint = CASE
      WHEN provider_account_fingerprint IS NOT NULL
      THEN provider_account_fingerprint
      WHEN NEW.status = 'active' AND NEW.webhook_status = 'verified'
      THEN NEW.provider_identity_fingerprint
      ELSE NULL
    END,
    provider_account_verified_at = CASE
      WHEN provider_account_verified_at IS NOT NULL
      THEN provider_account_verified_at
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN COALESCE(
        NEW.last_webhook_verified_at,
        NEW.last_checked_at,
        NEW.connected_at,
        NEW.updated_at
      )
      ELSE NULL
    END,
    last_safe_error_code = NEW.last_safe_error_code,
    last_checked_at = NEW.last_checked_at,
    last_webhook_verified_at = NEW.last_webhook_verified_at,
    connected_at = NEW.connected_at,
    disconnected_at = CASE
      WHEN NEW.status = 'disconnected' THEN NEW.updated_at ELSE NULL
    END,
    version = version + 1,
    updated_at = NEW.updated_at
  WHERE shop_id = NEW.shop_id
    AND legacy_payos_integration_id = NEW.id;

  UPDATE payment_provider_connection_capabilities
  SET effective_enabled = CASE
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN 1 ELSE 0
    END,
    evaluated_at = NEW.updated_at
  WHERE shop_id = NEW.shop_id AND connection_id = NEW.id;

  UPDATE payment_provider_connection_currencies
  SET effective_enabled = CASE
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN 1 ELSE 0
    END,
    evaluated_at = NEW.updated_at
  WHERE shop_id = NEW.shop_id AND connection_id = NEW.id;

  UPDATE payment_provider_connection_methods
  SET effective_enabled = CASE
      WHEN NEW.status = 'active'
        AND NEW.webhook_status = 'verified'
        AND NEW.provider_identity_fingerprint IS NOT NULL
      THEN 1 ELSE 0
    END,
    evaluated_at = NEW.updated_at
  WHERE shop_id = NEW.shop_id AND connection_id = NEW.id;
END;
