import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-29T00:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function applyMigrationsThrough(database: DatabaseSync, maximumMigration: number): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumMigration)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function createPreMigrationDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrationsThrough(database, 34);
  return database;
}

function seedLegacyPayOS(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at, merchant_country_code,
      business_country_code
    ) VALUES
      ('shop-a', 'shop-public-a', 'shop-a', 'Shop A', 'active', 'en', 'VND',
        'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}', 'JP', 'JP'),
      ('shop-b', 'shop-public-b', 'shop-b', 'Shop B', 'active', 'vi-VN', 'VND',
        'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}', 'VN', 'VN'),
      ('shop-c', 'shop-public-c', 'shop-c', 'Shop C', 'active', 'en', 'VND',
        'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}', 'US', 'US');

    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status,
      webhook_status, account_bin, account_number_masked,
      account_name_sanitized, last_safe_error_code, connected_at,
      created_at, updated_at, last_checked_at, last_webhook_verified_at,
      provider_identity_fingerprint
    ) VALUES
      ('integration-a', 'integration-public-a', 'webhook-public-a', 'shop-a',
        'payos', 'active', 'verified', '9704', '******1234', 'Shop A', NULL,
        '${NOW}', '${NOW}', '${NOW}', '${NOW}', '${NOW}', 'provider-fingerprint-a'),
      ('integration-b', 'integration-public-b', 'webhook-public-b', 'shop-b',
        'payos', 'disconnected', 'disconnected', '9704', '******5678', 'Shop B',
        'provider_disconnected', '${NOW}', '${NOW}', '${NOW}', '${NOW}',
        '${NOW}', 'provider-fingerprint-b'),
      ('integration-c', 'integration-public-c', 'webhook-public-c', 'shop-c',
        'payos', 'pending', 'pending', '9704', '******9012', 'Shop C', NULL,
        NULL, '${NOW}', '${NOW}', '${NOW}', NULL, 'provider-fingerprint-c');
  `);
}

function applyMigration(database: DatabaseSync): void {
  database.exec(readFileSync(
    join(process.cwd(), "migrations/0035_payment_provider_connections.sql"),
    "utf8",
  ));
}

function applyIdentityShredMigration(database: DatabaseSync): void {
  database.exec(readFileSync(
    join(process.cwd(), "migrations/0039_payment_provider_identity_shred.sql"),
    "utf8",
  ));
}

function applySettlementPolicyMigration(database: DatabaseSync): void {
  database.exec(readFileSync(
    join(process.cwd(), "migrations/0043_payment_settlement_policy_guard.sql"),
    "utf8",
  ));
}

function insertConnection(database: DatabaseSync, input: {
  country?: string | null;
  environment?: "live" | "sandbox" | "unknown";
  fingerprint?: string | null;
  id: string;
  legacyIntegrationId?: string | null;
  providerCode?: string;
  publicId?: string;
  shopId: string;
  status?: "active" | "degraded" | "disconnected" | "pending";
  webhookStatus?: "disconnected" | "error" | "pending" | "verified";
}): void {
  database.prepare(`
    INSERT INTO payment_provider_connections (
      id, public_id, shop_id, provider_code, provider_environment,
      provider_descriptor_version, capability_policy_version, connection_mode,
      settlement_mode, credential_ownership, merchant_country_code, status,
      webhook_status, provider_account_fingerprint,
      provider_account_verified_at, version, created_at, updated_at,
      legacy_payos_integration_id
    ) VALUES (?, ?, ?, ?, ?, 1, 1, 'bring_your_own', 'direct', 'seller',
      ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    input.id,
    input.publicId ?? `public-${input.id}`,
    input.shopId,
    input.providerCode ?? "fakepay",
    input.environment ?? "sandbox",
    input.country ?? null,
    input.status ?? "pending",
    input.webhookStatus ?? "pending",
    input.fingerprint ?? null,
    input.fingerprint === undefined || input.fingerprint === null ? null : NOW,
    NOW,
    NOW,
    input.legacyIntegrationId ?? null,
  );
}

function indexColumns(database: DatabaseSync, indexName: string): string[] {
  return database.prepare(`PRAGMA index_info('${indexName}')`).all()
    .map((entry) => String(entry.name));
}

describe("payment provider connections migration", () => {
  it("projects legacy PayOS deterministically without changing its authoritative rows", () => {
    const database = createPreMigrationDatabase();
    seedLegacyPayOS(database);
    const legacyBefore = database.prepare("SELECT * FROM payment_integrations ORDER BY id").all();

    applyMigration(database);

    expect(database.prepare("SELECT * FROM payment_integrations ORDER BY id").all()).toEqual(legacyBefore);
    const legacyTable = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payment_integrations'
    `).get() as { sql: string };
    expect(legacyTable.sql).toContain("CHECK (provider = 'payos')");

    expect(database.prepare(`
      SELECT id, public_id AS publicId, shop_id AS shopId, provider_code AS providerCode,
        provider_environment AS providerEnvironment,
        provider_descriptor_version AS providerDescriptorVersion,
        capability_policy_version AS capabilityPolicyVersion,
        connection_mode AS connectionMode, settlement_mode AS settlementMode,
        credential_ownership AS credentialOwnership,
        merchant_country_code AS merchantCountryCode, status, webhook_status AS webhookStatus,
        legacy_payos_integration_id AS legacyIntegrationId
      FROM payment_provider_connections ORDER BY id
    `).all()).toEqual([
      {
        connectionMode: "bring_your_own",
        credentialOwnership: "seller",
        id: "integration-a",
        legacyIntegrationId: "integration-a",
        merchantCountryCode: "JP",
        capabilityPolicyVersion: 1,
        providerDescriptorVersion: 1,
        providerCode: "payos",
        providerEnvironment: "unknown",
        publicId: "integration-public-a",
        settlementMode: "direct",
        shopId: "shop-a",
        status: "active",
        webhookStatus: "verified",
      },
      {
        connectionMode: "bring_your_own",
        credentialOwnership: "seller",
        id: "integration-b",
        legacyIntegrationId: "integration-b",
        merchantCountryCode: "VN",
        capabilityPolicyVersion: 1,
        providerDescriptorVersion: 1,
        providerCode: "payos",
        providerEnvironment: "unknown",
        publicId: "integration-public-b",
        settlementMode: "direct",
        shopId: "shop-b",
        status: "disconnected",
        webhookStatus: "disconnected",
      },
      {
        connectionMode: "bring_your_own",
        credentialOwnership: "seller",
        id: "integration-c",
        legacyIntegrationId: "integration-c",
        merchantCountryCode: "US",
        capabilityPolicyVersion: 1,
        providerDescriptorVersion: 1,
        providerCode: "payos",
        providerEnvironment: "unknown",
        publicId: "integration-public-c",
        settlementMode: "direct",
        shopId: "shop-c",
        status: "pending",
        webhookStatus: "pending",
      },
    ]);

    expect(database.prepare(`
      SELECT capability_code AS capabilityCode, provider_granted AS providerGranted,
        effective_enabled AS effectiveEnabled
      FROM payment_provider_connection_capabilities
      WHERE shop_id = 'shop-a' AND connection_id = 'integration-a'
      ORDER BY capability_code
    `).all()).toEqual([
      { capabilityCode: "checkout.create", effectiveEnabled: 1, providerGranted: 1 },
      { capabilityCode: "credential.health", effectiveEnabled: 1, providerGranted: 1 },
      { capabilityCode: "payment.reconcile", effectiveEnabled: 1, providerGranted: 1 },
      { capabilityCode: "webhook.verify", effectiveEnabled: 1, providerGranted: 1 },
    ]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM payment_provider_connection_capabilities
      WHERE capability_code = 'refund.create'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT currency_code AS currencyCode, provider_supported AS providerSupported,
        effective_enabled AS effectiveEnabled
      FROM payment_provider_connection_currencies
      WHERE shop_id = 'shop-a' AND connection_id = 'integration-a'
    `).get()).toEqual({ currencyCode: "VND", effectiveEnabled: 1, providerSupported: 1 });
    expect(database.prepare(`
      SELECT method_code AS methodCode, provider_supported AS providerSupported,
        effective_enabled AS effectiveEnabled
      FROM payment_provider_connection_methods
      WHERE shop_id = 'shop-a' AND connection_id = 'integration-a'
    `).get()).toEqual({ effectiveEnabled: 1, methodCode: "bank_transfer_qr", providerSupported: 1 });
    expect(database.prepare(`
      SELECT DISTINCT effective_enabled AS effectiveEnabled
      FROM payment_provider_connection_capabilities
      WHERE shop_id = 'shop-b' AND connection_id = 'integration-b'
    `).all()).toEqual([{ effectiveEnabled: 0 }]);
    expect(database.prepare(`
      SELECT provider_account_fingerprint AS fingerprint, status, webhook_status AS webhookStatus
      FROM payment_provider_connections WHERE id = 'integration-c'
    `).get()).toEqual({ fingerprint: null, status: "pending", webhookStatus: "pending" });

    expect(indexColumns(database, "idx_payment_provider_connections_shop_status"))
      .toEqual(["shop_id", "status", "updated_at", "id"]);
    expect(indexColumns(database, "idx_payment_provider_connection_capabilities_shop_effective"))
      .toEqual(["shop_id", "effective_enabled", "capability_code", "connection_id"]);
    expect(indexColumns(database, "idx_payment_provider_connection_currencies_shop_effective"))
      .toEqual(["shop_id", "effective_enabled", "currency_code", "connection_id"]);
    expect(indexColumns(database, "idx_payment_provider_connection_methods_shop_effective"))
      .toEqual(["shop_id", "effective_enabled", "method_code", "connection_id"]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects cross-tenant links, invalid registries and capability overclaims", () => {
    const database = createPreMigrationDatabase();
    seedLegacyPayOS(database);
    applyMigration(database);

    expect(() => { insertConnection(database, {
      id: "cross-tenant-legacy",
      legacyIntegrationId: "integration-a",
      providerCode: "payos",
      shopId: "shop-b",
    }); }).toThrow(/payment_provider_connection_legacy_link_invalid|FOREIGN KEY/u);
    expect(() => { insertConnection(database, {
      country: "ZZ",
      id: "invalid-country",
      shopId: "shop-a",
    }); }).toThrow(/payment_provider_connection_merchant_country_mismatch|FOREIGN KEY/u);
    expect(() => { insertConnection(database, {
      country: "VN",
      id: "merchant-country-mismatch",
      shopId: "shop-a",
    }); }).toThrow(/payment_provider_connection_merchant_country_mismatch/u);
    expect(() => { insertConnection(database, {
      environment: "unknown",
      id: "unknown-environment-without-legacy-link",
      shopId: "shop-a",
    }); }).toThrow(/CHECK/u);
    insertConnection(database, {
      fingerprint: "provider-fingerprint-shared",
      id: "authenticated-identity-owner",
      providerCode: "payos",
      shopId: "shop-a",
      status: "active",
      webhookStatus: "verified",
    });
    expect(() => { insertConnection(database, {
      fingerprint: "provider-fingerprint-shared",
      id: "duplicate-live-identity",
      providerCode: "payos",
      shopId: "shop-b",
      status: "active",
      webhookStatus: "verified",
    }); }).toThrow(/UNIQUE/u);
    expect(() => { insertConnection(database, {
      fingerprint: "provider-fingerprint-c",
      id: "pending-identity-does-not-squat",
      providerCode: "payos",
      shopId: "shop-a",
    }); }).toThrow(/CHECK/u);
    expect(() => { insertConnection(database, {
      fingerprint: "provider-fingerprint-c",
      id: "authenticated-identity-claim",
      providerCode: "payos",
      shopId: "shop-b",
      status: "active",
      webhookStatus: "verified",
    }); }).not.toThrow();
    expect(() => { insertConnection(database, {
      fingerprint: "provider-fingerprint-c",
      id: "duplicate-authenticated-identity-claim",
      providerCode: "payos",
      shopId: "shop-c",
      status: "active",
      webhookStatus: "verified",
    }); }).toThrow(/UNIQUE/u);

    expect(() => database.prepare(`
      INSERT INTO payment_provider_connection_currencies (
        shop_id, connection_id, currency_code, provider_supported,
        effective_enabled, provider_descriptor_version,
        capability_policy_version, evaluated_at
      ) VALUES ('shop-a', 'integration-a', 'GBP', 1, 1, 1, 1, ?)
    `).run(NOW)).toThrow(/FOREIGN KEY|connection_ineligible/u);
    expect(() => database.prepare(`
      INSERT INTO payment_provider_connection_methods (
        shop_id, connection_id, method_code, provider_supported,
        effective_enabled, provider_descriptor_version,
        capability_policy_version, evaluated_at
      ) VALUES ('shop-a', 'integration-a', 'cash', 1, 1, 1, 1, ?)
    `).run(NOW)).toThrow(/FOREIGN KEY|connection_ineligible/u);
    expect(() => database.prepare(`
      INSERT INTO payment_provider_connection_capabilities (
        shop_id, connection_id, capability_code, provider_granted,
        effective_enabled, provider_descriptor_version,
        capability_policy_version, granted_at, evaluated_at
      ) VALUES ('shop-a', 'integration-a', 'order.fulfill', 1, 1, 1, 1, ?, ?)
    `).run(NOW, NOW)).toThrow(/CHECK/u);
    expect(() => database.prepare(`
      INSERT INTO payment_provider_connection_capabilities (
        shop_id, connection_id, capability_code, provider_granted,
        effective_enabled, provider_descriptor_version,
        capability_policy_version, granted_at, evaluated_at
      ) VALUES ('shop-a', 'integration-a', 'refund.create', 0, 1, 1, 1, ?, ?)
    `).run(NOW, NOW)).toThrow(/CHECK/u);

    expect(() => database.prepare(`
      INSERT INTO payment_provider_connection_currencies (
        shop_id, connection_id, currency_code, provider_supported,
        effective_enabled, provider_descriptor_version,
        capability_policy_version, evaluated_at
      ) VALUES ('shop-b', 'integration-a', 'USD', 1, 1, 1, 1, ?)
    `).run(NOW)).toThrow(/FOREIGN KEY|connection_ineligible/u);
    expect(() => database.prepare(`
      INSERT INTO payment_provider_connection_methods (
        shop_id, connection_id, method_code, provider_supported,
        effective_enabled, provider_descriptor_version,
        capability_policy_version, evaluated_at
      ) VALUES ('shop-b', 'integration-a', 'card', 1, 1, 1, 1, ?)
    `).run(NOW)).toThrow(/FOREIGN KEY|connection_ineligible/u);
    expect(() => database.prepare(`
      INSERT INTO payment_provider_connection_capabilities (
        shop_id, connection_id, capability_code, provider_granted,
        effective_enabled, provider_descriptor_version,
        capability_policy_version, granted_at, evaluated_at
      ) VALUES ('shop-b', 'integration-a', 'refund.create', 1, 1, 1, 1, ?, ?)
    `).run(NOW, NOW)).toThrow(/FOREIGN KEY|connection_ineligible/u);

    insertConnection(database, { id: "attestation-fill-once", shopId: "shop-a" });
    database.prepare(`
      UPDATE payment_provider_connections
      SET status = 'active', webhook_status = 'verified',
        provider_account_fingerprint = 'attested-account-fingerprint',
        provider_account_verified_at = ?, provider_attested_country_code = 'JP',
        provider_country_attested_at = ?, updated_at = ?, version = 2
      WHERE id = 'attestation-fill-once'
    `).run(NOW, NOW, NOW);
    expect(() => database.prepare(`
      UPDATE payment_provider_connections
      SET provider_account_fingerprint = 'different-account-fingerprint',
        updated_at = ?, version = 3
      WHERE id = 'attestation-fill-once'
    `).run(NOW)).toThrow(/payment_provider_connection_identity_immutable/u);
    expect(() => database.prepare(`
      UPDATE payment_provider_connections
      SET provider_attested_country_code = 'US', updated_at = ?, version = 3
      WHERE id = 'attestation-fill-once'
    `).run(NOW)).toThrow(/payment_provider_connection_identity_immutable/u);

    database.prepare(`
      UPDATE payment_provider_connections
      SET status = 'degraded', updated_at = ?, version = 2
      WHERE id = 'integration-a'
    `).run(NOW);
    for (const table of [
      "payment_provider_connection_capabilities",
      "payment_provider_connection_currencies",
      "payment_provider_connection_methods",
    ]) {
      expect(database.prepare(`
        SELECT SUM(effective_enabled) AS enabled FROM ${table}
        WHERE shop_id = 'shop-a' AND connection_id = 'integration-a'
      `).get()).toEqual({ enabled: 0 });
    }
    expect(() => database.prepare(`
      INSERT INTO payment_provider_connection_capabilities (
        shop_id, connection_id, capability_code, provider_granted,
        effective_enabled, provider_descriptor_version,
        capability_policy_version, granted_at, evaluated_at
      ) VALUES ('shop-a', 'integration-a', 'refund.create', 1, 1, 1, 1, ?, ?)
    `).run(NOW, NOW)).toThrow(/payment_provider_capability_connection_ineligible/u);

    expect(() => database.prepare(`
      UPDATE payment_provider_connections
      SET status = 'active', webhook_status = 'verified', updated_at = ?, version = 2
      WHERE id = 'integration-b'
    `).run(NOW)).toThrow(/payment_provider_connection_(status|webhook)_transition_invalid/u);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("releases provider identity only under the tenant deletion crypto-shred fence", () => {
    const database = createPreMigrationDatabase();
    seedLegacyPayOS(database);
    applyMigration(database);
    applyIdentityShredMigration(database);

    database.prepare(`
      UPDATE payment_provider_connections
      SET status = 'disconnected', webhook_status = 'disconnected',
        disconnected_at = ?, updated_at = ?, version = version + 1
      WHERE id = 'integration-a' AND shop_id = 'shop-a'
    `).run(NOW, NOW);
    expect(() => database.prepare(`
      UPDATE payment_provider_connections
      SET provider_account_fingerprint = NULL,
        provider_account_verified_at = NULL,
        updated_at = ?, version = version + 1
      WHERE id = 'integration-a' AND shop_id = 'shop-a'
    `).run(NOW)).toThrow(/payment_provider_connection_identity_immutable/u);

    database.exec(`
      INSERT INTO shop_deletion_requests (
        id, shop_id, status, reason_code, request_id, grace_ends_at,
        financial_records_retain_until, checkout_blocked_at,
        routing_removed_at, provider_cleanup_completed_at,
        secret_material_destroyed_json, version, created_at, updated_at
      ) VALUES (
        'deletion-shop-a', 'shop-a', 'processing', 'seller_request',
        'request-deletion-shop-a', '${NOW}', '2033-07-29T00:00:00.000Z',
        '${NOW}', '${NOW}', '${NOW}', '{}', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO shop_deletion_steps (
        id, request_id, shop_id, step_code, sequence_no, status,
        attempt_count, lease_token, lease_expires_at, started_at,
        version, created_at, updated_at
      ) VALUES (
        'deletion-step-shop-a', 'deletion-shop-a', 'shop-a', 'crypto_shred',
        8, 'processing', 1, 'lease-shop-a',
        '2026-07-29T01:00:00.000Z', '${NOW}', 1, '${NOW}', '${NOW}'
      );
    `);
    database.prepare(`
      UPDATE payment_provider_connections
      SET provider_attested_country_code = NULL,
        provider_country_attested_at = NULL,
        provider_account_fingerprint = NULL,
        provider_account_verified_at = NULL,
        updated_at = ?, version = version + 1
      WHERE id = 'integration-a' AND shop_id = 'shop-a'
    `).run(NOW);

    expect(database.prepare(`
      SELECT provider_attested_country_code AS attestedCountry,
        provider_country_attested_at AS countryAttestedAt,
        provider_account_fingerprint AS fingerprint,
        provider_account_verified_at AS verifiedAt
      FROM payment_provider_connections
      WHERE id = 'integration-a' AND shop_id = 'shop-a'
    `).get()).toEqual({
      attestedCountry: null,
      countryAttestedAt: null,
      fingerprint: null,
      verifiedAt: null,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves seller-direct, provider-partner MoR and legacy PayOS rows while guarding future writes", () => {
    const database = createPreMigrationDatabase();
    seedLegacyPayOS(database);
    applyMigration(database);
    database.exec(`
      INSERT INTO payment_provider_connections (
        id, public_id, shop_id, provider_code, provider_environment,
        provider_descriptor_version, capability_policy_version,
        connection_mode, settlement_mode, credential_ownership,
        merchant_country_code, status, webhook_status, version,
        created_at, updated_at
      ) VALUES (
        'managed-mor', 'public-managed-mor', 'shop-a', 'partnerpay', 'sandbox',
        1, 1, 'managed', 'mor_partner', 'provider_partner', 'JP',
        'pending', 'pending', 1, '${NOW}', '${NOW}'
      )
    `);
    const before = database.prepare(`
      SELECT id, connection_mode AS connectionMode,
        settlement_mode AS settlementMode,
        credential_ownership AS credentialOwnership
      FROM payment_provider_connections
      ORDER BY id
    `).all();

    applySettlementPolicyMigration(database);

    expect(database.prepare(`
      SELECT id, connection_mode AS connectionMode,
        settlement_mode AS settlementMode,
        credential_ownership AS credentialOwnership
      FROM payment_provider_connections
      ORDER BY id
    `).all()).toEqual(before);
    expect(before).toEqual(expect.arrayContaining([
      {
        connectionMode: "bring_your_own",
        credentialOwnership: "seller",
        id: "integration-a",
        settlementMode: "direct",
      },
      {
        connectionMode: "managed",
        credentialOwnership: "provider_partner",
        id: "managed-mor",
        settlementMode: "mor_partner",
      },
    ]));

    expect(() => {
      database.exec(`
        INSERT INTO payment_provider_connections (
          id, public_id, shop_id, provider_code, provider_environment,
          provider_descriptor_version, capability_policy_version,
          connection_mode, settlement_mode, credential_ownership,
          merchant_country_code, status, webhook_status, version,
          created_at, updated_at
        ) VALUES (
          'managed-direct', 'public-managed-direct', 'shop-a', 'managedpay', 'sandbox',
          1, 1, 'managed', 'direct', 'platform', 'JP',
          'pending', 'pending', 1, '${NOW}', '${NOW}'
        )
      `);
    }).toThrow(/payment_provider_connection_settlement_policy_invalid/u);
    expect(() => database.prepare(`
      UPDATE payment_provider_connections
      SET connection_mode = 'managed', credential_ownership = 'platform'
      WHERE id = 'integration-a'
    `).run()).toThrow(/payment_provider_connection_settlement_policy_invalid/u);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("fails deterministically when a persisted connection violates settlement policy", () => {
    const database = createPreMigrationDatabase();
    seedLegacyPayOS(database);
    applyMigration(database);
    database.exec(`
      INSERT INTO payment_provider_connections (
        id, public_id, shop_id, provider_code, provider_environment,
        provider_descriptor_version, capability_policy_version,
        connection_mode, settlement_mode, credential_ownership,
        merchant_country_code, status, webhook_status, version,
        created_at, updated_at
      ) VALUES (
        'persisted-managed-direct', 'public-persisted-managed-direct',
        'shop-a', 'managedpay', 'sandbox', 1, 1, 'managed', 'direct',
        'platform', 'JP', 'pending', 'pending', 1, '${NOW}', '${NOW}'
      )
    `);

    expect(() => {
      applySettlementPolicyMigration(database);
    })
      .toThrow(/migration_0043_payment_settlement_policy_valid/u);

    database.prepare(`
      DELETE FROM payment_provider_connections WHERE id = 'persisted-managed-direct'
    `).run();
    expect(() => {
      applySettlementPolicyMigration(database);
    }).not.toThrow();
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'migration_0043_payment_settlement_policy_validation'
    `).get()).toEqual({ count: 0 });
  });
});
