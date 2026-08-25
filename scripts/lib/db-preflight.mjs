export const PHASE7_PREFLIGHT_SQL = `
SELECT
  (
    SELECT COUNT(*)
    FROM (
      SELECT shop_id
      FROM shop_domains
      WHERE is_primary = 1
      GROUP BY shop_id
      HAVING COUNT(*) > 1
    )
  ) AS duplicate_primary_shops,
  (
    SELECT COUNT(*)
    FROM (
      SELECT cloudflare_hostname_id
      FROM shop_domains
      WHERE cloudflare_hostname_id IS NOT NULL
      GROUP BY cloudflare_hostname_id
      HAVING COUNT(*) > 1
    )
  ) AS duplicate_provider_ids,
  (SELECT COUNT(*) FROM shop_domains WHERE type = 'custom') AS legacy_custom_domains,
  (
    SELECT COUNT(*)
    FROM shops
    LEFT JOIN shop_domains AS canonical ON canonical.id = shops.canonical_domain_id
    WHERE shops.canonical_domain_id IS NOT NULL
      AND (
        canonical.id IS NULL
        OR canonical.shop_id <> shops.id
        OR canonical.status <> 'active'
        OR canonical.is_primary <> 1
      )
  ) AS invalid_canonical_links,
  (SELECT COUNT(*) FROM shops WHERE canonical_domain_id IS NULL) AS canonical_null_shops,
  (
    SELECT COUNT(*)
    FROM payment_attempts
    WHERE state IN ('creating', 'pending', 'error')
      AND datetime(expires_at) > CURRENT_TIMESTAMP
      AND NOT EXISTS (
        SELECT 1
        FROM shops
        INNER JOIN shop_domains AS canonical
          ON canonical.id = shops.canonical_domain_id
          AND canonical.shop_id = shops.id
          AND canonical.status = 'active'
          AND canonical.is_primary = 1
        WHERE shops.id = payment_attempts.shop_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM shop_domains AS fallback_primary
        WHERE fallback_primary.shop_id = payment_attempts.shop_id
          AND fallback_primary.status = 'active'
          AND fallback_primary.is_primary = 1
      )
  ) AS unresolved_active_attempt_origins;
`;

export const PAYMENT_PROVIDER_SCHEMA_TABLES = Object.freeze([
  "iso_4217_currency_codes",
  "payment_method_codes",
  "payment_provider_connection_capabilities",
  "payment_provider_connection_currencies",
  "payment_provider_connection_methods",
  "payment_provider_connections",
]);

export const PAYMENT_PROVIDER_SCHEMA_SQL = `
SELECT name
FROM sqlite_master
WHERE type = 'table'
  AND name IN (${PAYMENT_PROVIDER_SCHEMA_TABLES.map((table) => `'${table}'`).join(", ")})
ORDER BY name;
`;

export const PAYOS_RELATIONSHIP_PREFLIGHT_SQL = `
SELECT
  (
    SELECT COUNT(*)
    FROM payment_integrations AS integration
    WHERE integration.active_credential_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM payment_credentials AS credential
        WHERE credential.id = integration.active_credential_id
          AND credential.shop_id = integration.shop_id
          AND credential.integration_id = integration.id
          AND credential.provider = integration.provider
          AND credential.status = 'active'
      )
  ) AS invalid_payos_active_credential_links,
  (
    SELECT COUNT(*)
    FROM payment_credentials AS credential
    WHERE NOT EXISTS (
      SELECT 1
      FROM payment_integrations AS integration
      WHERE integration.id = credential.integration_id
        AND integration.shop_id = credential.shop_id
        AND integration.provider = credential.provider
    )
  ) AS invalid_payos_credential_integration_links,
  (
    SELECT COUNT(*)
    FROM payment_attempts AS attempt
    WHERE NOT EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = attempt.order_id
        AND orders.shop_id = attempt.shop_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM payment_integrations AS integration
      WHERE integration.id = attempt.integration_id
        AND integration.shop_id = attempt.shop_id
        AND integration.provider = attempt.provider
    )
    OR NOT EXISTS (
      SELECT 1 FROM payment_credentials AS credential
      WHERE credential.id = attempt.credential_id
        AND credential.shop_id = attempt.shop_id
        AND credential.integration_id = attempt.integration_id
        AND credential.provider = attempt.provider
    )
  ) AS invalid_payos_attempt_links,
  (
    SELECT COUNT(*)
    FROM payment_events AS event
    WHERE NOT EXISTS (
      SELECT 1 FROM payment_integrations AS integration
      WHERE integration.id = event.integration_id
        AND integration.shop_id = event.shop_id
        AND integration.provider = event.provider
    )
    OR (
      event.payment_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM payment_attempts AS attempt
        WHERE attempt.id = event.payment_attempt_id
          AND attempt.shop_id = event.shop_id
          AND attempt.integration_id = event.integration_id
          AND attempt.provider = event.provider
      )
    )
  ) AS invalid_payos_event_links,
  (
    SELECT COUNT(*)
    FROM payment_exceptions AS exception
    WHERE NOT EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = exception.order_id
        AND orders.shop_id = exception.shop_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM payment_attempts AS attempt
      WHERE attempt.id = exception.payment_attempt_id
        AND attempt.shop_id = exception.shop_id
        AND attempt.order_id = exception.order_id
    )
  ) AS invalid_payos_exception_links,
  (
    SELECT COUNT(*)
    FROM payment_attempts AS attempt
    WHERE attempt.paid_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM payment_events AS event
        WHERE event.id = attempt.paid_event_id
          AND event.payment_attempt_id = attempt.id
          AND event.shop_id = attempt.shop_id
          AND event.integration_id = attempt.integration_id
          AND event.provider = attempt.provider
      )
  ) AS invalid_payos_paid_event_links;
`;

export const PAYMENT_PROVIDER_PREFLIGHT_SQL = `
SELECT
  (
    SELECT COUNT(*)
    FROM payment_integrations AS integration
    WHERE integration.provider = 'payos'
      AND NOT EXISTS (
        SELECT 1
        FROM payment_provider_connections AS connection
        WHERE connection.shop_id = integration.shop_id
          AND connection.legacy_payos_integration_id = integration.id
          AND connection.provider_code = integration.provider
      )
  ) AS missing_payos_connections,
  (
    SELECT COUNT(*)
    FROM payment_provider_connections AS connection
    LEFT JOIN payment_integrations AS integration
      ON integration.id = connection.legacy_payos_integration_id
      AND integration.shop_id = connection.shop_id
    WHERE connection.legacy_payos_integration_id IS NOT NULL
      AND (
        integration.id IS NULL
        OR integration.provider <> 'payos'
        OR connection.provider_code <> integration.provider
        OR connection.public_id <> integration.public_id
        OR connection.provider_environment <> 'unknown'
        OR connection.connection_mode <> 'bring_your_own'
        OR connection.settlement_mode <> 'direct'
        OR connection.credential_ownership <> 'seller'
        OR connection.status <> CASE integration.status WHEN 'error' THEN 'degraded' ELSE integration.status END
        OR connection.webhook_status <> CASE
          WHEN integration.status = 'error'
            AND connection.provider_account_fingerprint IS NOT NULL
          THEN 'verified'
          ELSE integration.webhook_status
        END
        OR connection.provider_account_fingerprint IS NOT CASE
          WHEN integration.status = 'active' AND integration.webhook_status = 'verified'
          THEN integration.provider_identity_fingerprint
          WHEN integration.status IN ('error', 'disconnected')
            AND connection.provider_account_fingerprint IS NOT NULL
          THEN integration.provider_identity_fingerprint
          ELSE NULL
        END
      )
  ) AS invalid_payos_connection_links,
  (
    SELECT COUNT(*)
    FROM payment_provider_connections AS connection
    WHERE connection.provider_code = 'payos'
      AND connection.legacy_payos_integration_id IS NOT NULL
      AND (
        (
          SELECT COUNT(*)
          FROM payment_provider_connection_capabilities AS capability
          WHERE capability.shop_id = connection.shop_id
            AND capability.connection_id = connection.id
            AND capability.capability_code IN (
              'checkout.create', 'credential.health', 'payment.reconcile', 'webhook.verify'
            )
            AND capability.provider_granted = 1
        ) <> 4
        OR EXISTS (
          SELECT 1
          FROM payment_provider_connection_capabilities AS capability
          WHERE capability.shop_id = connection.shop_id
            AND capability.connection_id = connection.id
            AND capability.capability_code IN (
              'checkout.create', 'credential.health', 'payment.reconcile', 'webhook.verify'
            )
            AND capability.effective_enabled <> CASE
              WHEN connection.status = 'active'
                AND connection.webhook_status = 'verified'
                AND connection.provider_account_fingerprint IS NOT NULL THEN 1
              ELSE 0
            END
        )
      )
  ) AS invalid_payos_capability_grants,
  (
    SELECT COUNT(*)
    FROM payment_provider_connections AS connection
    WHERE connection.provider_code = 'payos'
      AND connection.legacy_payos_integration_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM payment_provider_connection_currencies AS currency
        WHERE currency.shop_id = connection.shop_id
          AND currency.connection_id = connection.id
          AND currency.currency_code = 'VND'
          AND currency.provider_supported = 1
          AND currency.effective_enabled = CASE
            WHEN connection.status = 'active'
              AND connection.webhook_status = 'verified'
              AND connection.provider_account_fingerprint IS NOT NULL THEN 1
            ELSE 0
          END
      )
  ) AS invalid_payos_currency_grants,
  (
    SELECT COUNT(*)
    FROM payment_provider_connections AS connection
    WHERE connection.provider_code = 'payos'
      AND connection.legacy_payos_integration_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM payment_provider_connection_methods AS method
        WHERE method.shop_id = connection.shop_id
          AND method.connection_id = connection.id
          AND method.method_code = 'bank_transfer_qr'
          AND method.provider_supported = 1
          AND method.effective_enabled = CASE
            WHEN connection.status = 'active'
              AND connection.webhook_status = 'verified'
              AND connection.provider_account_fingerprint IS NOT NULL THEN 1
            ELSE 0
          END
      )
  ) AS invalid_payos_method_grants,
  (
    SELECT COUNT(*)
    FROM payment_provider_connection_capabilities AS capability
    INNER JOIN payment_provider_connections AS connection
      ON connection.shop_id = capability.shop_id
      AND connection.id = capability.connection_id
    WHERE capability.effective_enabled = 1
      AND (
        capability.provider_granted <> 1
        OR capability.revoked_at IS NOT NULL
        OR connection.status <> 'active'
        OR connection.webhook_status <> 'verified'
        OR connection.provider_account_fingerprint IS NULL
        OR capability.provider_descriptor_version <> connection.provider_descriptor_version
        OR capability.capability_policy_version <> connection.capability_policy_version
      )
  ) + (
    SELECT COUNT(*)
    FROM payment_provider_connection_currencies AS currency
    INNER JOIN payment_provider_connections AS connection
      ON connection.shop_id = currency.shop_id
      AND connection.id = currency.connection_id
    WHERE currency.effective_enabled = 1
      AND (
        currency.provider_supported <> 1
        OR connection.status <> 'active'
        OR connection.webhook_status <> 'verified'
        OR connection.provider_account_fingerprint IS NULL
        OR currency.provider_descriptor_version <> connection.provider_descriptor_version
        OR currency.capability_policy_version <> connection.capability_policy_version
      )
  ) + (
    SELECT COUNT(*)
    FROM payment_provider_connection_methods AS method
    INNER JOIN payment_provider_connections AS connection
      ON connection.shop_id = method.shop_id
      AND connection.id = method.connection_id
    WHERE method.effective_enabled = 1
      AND (
        method.provider_supported <> 1
        OR connection.status <> 'active'
        OR connection.webhook_status <> 'verified'
        OR connection.provider_account_fingerprint IS NULL
        OR method.provider_descriptor_version <> connection.provider_descriptor_version
        OR method.capability_policy_version <> connection.capability_policy_version
      )
  ) AS stale_effective_authorizations,
  (
    SELECT COUNT(*) FROM iso_4217_currency_codes WHERE code = 'VND' AND minor_unit <> 0
  ) + (
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM payment_method_codes WHERE code = 'bank_transfer_qr'
    ) THEN 0 ELSE 1 END
  ) AS invalid_payos_reference_codes;
`;

function safeCount(row, key) {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`db_preflight_invalid_result:${key}`);
  }
  return value;
}

export function parseD1PreflightOutput(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("db_preflight_invalid_json");
  }
  const envelope = Array.isArray(payload) ? payload[0] : payload;
  const row = envelope?.results?.[0];
  if (typeof row !== "object" || row === null) throw new Error("db_preflight_missing_result");
  return {
    canonicalNullShops: safeCount(row, "canonical_null_shops"),
    duplicatePrimaryShops: safeCount(row, "duplicate_primary_shops"),
    duplicateProviderIds: safeCount(row, "duplicate_provider_ids"),
    invalidCanonicalLinks: safeCount(row, "invalid_canonical_links"),
    legacyCustomDomains: safeCount(row, "legacy_custom_domains"),
    unresolvedActiveAttemptOrigins: safeCount(row, "unresolved_active_attempt_origins"),
  };
}

function parseD1Rows(output, errorCode) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error(`${errorCode}_invalid_json`);
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (
    envelopes.length === 0
    || envelopes.some((envelope) => (
      typeof envelope !== "object"
      || envelope === null
      || !Array.isArray(envelope.results)
    ))
  ) {
    throw new Error(`${errorCode}_invalid_result`);
  }
  const rows = envelopes.flatMap((envelope) => (
    envelope.results
  ));
  if (rows.some((row) => typeof row !== "object" || row === null)) {
    throw new Error(`${errorCode}_invalid_result`);
  }
  return rows;
}

export function parsePaymentProviderSchemaOutput(output) {
  const names = parseD1Rows(output, "db_preflight_schema").map((row) => row.name);
  if (names.some((name) => typeof name !== "string")) {
    throw new Error("db_preflight_schema_invalid_result");
  }
  const observed = new Set(names);
  if (observed.size !== names.length || names.some((name) => !PAYMENT_PROVIDER_SCHEMA_TABLES.includes(name))) {
    throw new Error("db_preflight_schema_invalid_result");
  }
  if (observed.size === 0) return { applied: false, tables: [] };
  const missing = PAYMENT_PROVIDER_SCHEMA_TABLES.filter((table) => !observed.has(table));
  if (missing.length > 0) throw new Error("db_preflight_payment_provider_schema_partial");
  return { applied: true, tables: [...PAYMENT_PROVIDER_SCHEMA_TABLES] };
}

export function parsePaymentProviderPreflightOutput(output) {
  const [row, ...extraRows] = parseD1Rows(output, "db_preflight_payment_provider");
  if (row === undefined || extraRows.length > 0) {
    throw new Error("db_preflight_payment_provider_invalid_result");
  }
  return {
    invalidPayosCapabilityGrants: safeCount(row, "invalid_payos_capability_grants"),
    invalidPayosConnectionLinks: safeCount(row, "invalid_payos_connection_links"),
    invalidPayosCurrencyGrants: safeCount(row, "invalid_payos_currency_grants"),
    invalidPayosMethodGrants: safeCount(row, "invalid_payos_method_grants"),
    invalidPayosReferenceCodes: safeCount(row, "invalid_payos_reference_codes"),
    missingPayosConnections: safeCount(row, "missing_payos_connections"),
    staleEffectiveAuthorizations: safeCount(row, "stale_effective_authorizations"),
  };
}

export function parsePayosRelationshipPreflightOutput(output) {
  const [row, ...extraRows] = parseD1Rows(output, "db_preflight_payos_relationship");
  if (row === undefined || extraRows.length > 0) {
    throw new Error("db_preflight_payos_relationship_invalid_result");
  }
  return {
    invalidPayosActiveCredentialLinks: safeCount(row, "invalid_payos_active_credential_links"),
    invalidPayosAttemptLinks: safeCount(row, "invalid_payos_attempt_links"),
    invalidPayosCredentialIntegrationLinks: safeCount(row, "invalid_payos_credential_integration_links"),
    invalidPayosEventLinks: safeCount(row, "invalid_payos_event_links"),
    invalidPayosExceptionLinks: safeCount(row, "invalid_payos_exception_links"),
    invalidPayosPaidEventLinks: safeCount(row, "invalid_payos_paid_event_links"),
  };
}

export function evaluatePhase7Preflight(counts) {
  const checks = [
    { code: "duplicate_primary_shops", detail: String(counts.duplicatePrimaryShops), ok: true },
    { code: "duplicate_provider_ids", detail: String(counts.duplicateProviderIds), ok: counts.duplicateProviderIds === 0 },
    { code: "legacy_custom_domains", detail: String(counts.legacyCustomDomains), ok: true },
    { code: "invalid_canonical_links", detail: String(counts.invalidCanonicalLinks), ok: true },
    { code: "canonical_null_shops", detail: String(counts.canonicalNullShops), ok: true },
    { code: "unresolved_active_attempt_origins", detail: String(counts.unresolvedActiveAttemptOrigins), ok: counts.unresolvedActiveAttemptOrigins === 0 },
  ];
  return { checks, ok: checks.every((check) => check.ok) };
}

export function evaluatePaymentProviderPreflight(counts) {
  const checks = [
    { code: "missing_payos_connections", detail: String(counts.missingPayosConnections), ok: counts.missingPayosConnections === 0 },
    { code: "invalid_payos_connection_links", detail: String(counts.invalidPayosConnectionLinks), ok: counts.invalidPayosConnectionLinks === 0 },
    { code: "invalid_payos_capability_grants", detail: String(counts.invalidPayosCapabilityGrants), ok: counts.invalidPayosCapabilityGrants === 0 },
    { code: "invalid_payos_currency_grants", detail: String(counts.invalidPayosCurrencyGrants), ok: counts.invalidPayosCurrencyGrants === 0 },
    { code: "invalid_payos_method_grants", detail: String(counts.invalidPayosMethodGrants), ok: counts.invalidPayosMethodGrants === 0 },
    { code: "stale_effective_authorizations", detail: String(counts.staleEffectiveAuthorizations), ok: counts.staleEffectiveAuthorizations === 0 },
    { code: "invalid_payos_reference_codes", detail: String(counts.invalidPayosReferenceCodes), ok: counts.invalidPayosReferenceCodes === 0 },
  ];
  return { checks, ok: checks.every((check) => check.ok) };
}

export function evaluatePayosRelationshipPreflight(counts) {
  const checks = [
    { code: "invalid_payos_active_credential_links", detail: String(counts.invalidPayosActiveCredentialLinks), ok: counts.invalidPayosActiveCredentialLinks === 0 },
    { code: "invalid_payos_credential_integration_links", detail: String(counts.invalidPayosCredentialIntegrationLinks), ok: counts.invalidPayosCredentialIntegrationLinks === 0 },
    { code: "invalid_payos_attempt_links", detail: String(counts.invalidPayosAttemptLinks), ok: counts.invalidPayosAttemptLinks === 0 },
    { code: "invalid_payos_event_links", detail: String(counts.invalidPayosEventLinks), ok: counts.invalidPayosEventLinks === 0 },
    { code: "invalid_payos_exception_links", detail: String(counts.invalidPayosExceptionLinks), ok: counts.invalidPayosExceptionLinks === 0 },
    { code: "invalid_payos_paid_event_links", detail: String(counts.invalidPayosPaidEventLinks), ok: counts.invalidPayosPaidEventLinks === 0 },
  ];
  return { checks, ok: checks.every((check) => check.ok) };
}
