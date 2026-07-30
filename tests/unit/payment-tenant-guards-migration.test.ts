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

function applyMigration(database: DatabaseSync, number: number): void {
  const filename = readdirSync(join(process.cwd(), "migrations"))
    .find((name) => name.startsWith(`${String(number).padStart(4, "0")}_`));
  if (filename === undefined) throw new Error(`missing_migration_${String(number)}`);
  database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
}

function createPreGuardDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrationsThrough(database, 34);
  seedLegacyGraph(database);
  applyMigration(database, 35);
  applyMigration(database, 36);
  return database;
}

function seedLegacyGraph(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (
      id, email_normalized, display_name, status, created_at, updated_at
    ) VALUES ('user-a', 'operator@example.test', 'Operator', 'active', '${NOW}', '${NOW}');

    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at, merchant_country_code,
      business_country_code
    ) VALUES
      ('shop-a', 'shop-public-a', 'shop-a', 'Shop A', 'active', 'en', 'VND',
        'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}', 'VN', 'VN'),
      ('shop-b', 'shop-public-b', 'shop-b', 'Shop B', 'active', 'en', 'VND',
        'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}', 'VN', 'VN'),
      ('shop-c', 'shop-public-c', 'shop-c', 'Shop C', 'active', 'en', 'VND',
        'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}', 'VN', 'VN');

    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, created_at, updated_at
    ) VALUES
      ('order-a1', 'order-public-a1', 'shop-a', 'A-1', 'web', 'pending_payment',
        'unpaid', 'unfulfilled', 1000, 0, 1000, 'VND', 'en', 'subject-a1',
        'token-a1', '2026-07-30T00:00:00.000Z', '${NOW}', '${NOW}'),
      ('order-a2', 'order-public-a2', 'shop-a', 'A-2', 'web', 'pending_payment',
        'unpaid', 'unfulfilled', 2000, 0, 2000, 'VND', 'en', 'subject-a2',
        'token-a2', '2026-07-30T00:00:00.000Z', '${NOW}', '${NOW}'),
      ('order-b1', 'order-public-b1', 'shop-b', 'B-1', 'web', 'pending_payment',
        'unpaid', 'unfulfilled', 3000, 0, 3000, 'VND', 'en', 'subject-b1',
        'token-b1', '2026-07-30T00:00:00.000Z', '${NOW}', '${NOW}');

    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status,
      webhook_status, created_at, updated_at, last_checked_at,
      last_webhook_verified_at, provider_identity_fingerprint
    ) VALUES
      ('integration-a', 'integration-public-a', 'webhook-a', 'shop-a', 'payos',
        'active', 'verified', '${NOW}', '${NOW}', '${NOW}', '${NOW}',
        'provider-fingerprint-a'),
      ('integration-b', 'integration-public-b', 'webhook-b', 'shop-b', 'payos',
        'active', 'verified', '${NOW}', '${NOW}', '${NOW}', '${NOW}',
        'provider-fingerprint-b');

    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, activated_at, created_by_user_id, created_at,
      provider_ownership_fingerprint
    ) VALUES
      ('credential-a', 'shop-a', 'integration-a', 'payos', 'active', 1, 'v1',
        'client-a', 'iv-client-a', 'api-a', 'iv-api-a', 'checksum-a',
        'iv-checksum-a', 'credential-fingerprint-a', '${NOW}', 'user-a', '${NOW}',
        'ownership-fingerprint-a'),
      ('credential-a-pending', 'shop-a', 'integration-a', 'payos', 'pending', 2, 'v1',
        'client-a2', 'iv-client-a2', 'api-a2', 'iv-api-a2', 'checksum-a2',
        'iv-checksum-a2', 'credential-fingerprint-a2', NULL, 'user-a', '${NOW}', NULL),
      ('credential-b', 'shop-b', 'integration-b', 'payos', 'active', 1, 'v1',
        'client-b', 'iv-client-b', 'api-b', 'iv-api-b', 'checksum-b',
        'iv-checksum-b', 'credential-fingerprint-b', '${NOW}', 'user-a', '${NOW}',
        'ownership-fingerprint-b');

    UPDATE payment_integrations SET active_credential_id = 'credential-a'
    WHERE id = 'integration-a';
    UPDATE payment_integrations SET active_credential_id = 'credential-b'
    WHERE id = 'integration-b';

    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency,
      expected_description, expires_at, created_at, updated_at
    ) VALUES
      ('attempt-a1', 'attempt-public-a1', 'shop-a', 'order-a1', 'integration-a',
        'credential-a', 'payos', 1001, 'pending', 1000, 'VND', 'PAY A1',
        '2026-07-30T00:00:00.000Z', '${NOW}', '${NOW}'),
      ('attempt-a2', 'attempt-public-a2', 'shop-a', 'order-a2', 'integration-a',
        'credential-a', 'payos', 1002, 'pending', 2000, 'VND', 'PAY A2',
        '2026-07-30T00:00:00.000Z', '${NOW}', '${NOW}'),
      ('attempt-b1', 'attempt-public-b1', 'shop-b', 'order-b1', 'integration-b',
        'credential-b', 'payos', 2001, 'pending', 3000, 'VND', 'PAY B1',
        '2026-07-30T00:00:00.000Z', '${NOW}', '${NOW}');

    INSERT INTO payment_events (
      id, shop_id, payment_attempt_id, integration_id, provider,
      provider_event_reference, payload_hash, signature_verified,
      normalized_state, process_result, received_at, processed_at
    ) VALUES
      ('event-a1', 'shop-a', 'attempt-a1', 'integration-a', 'payos', 'reference-a1',
        'payload-a1', 1, 'paid_exact', 'processed', '${NOW}', '${NOW}'),
      ('event-a2', 'shop-a', 'attempt-a2', 'integration-a', 'payos', 'reference-a2',
        'payload-a2', 1, 'paid_exact', 'processed', '${NOW}', '${NOW}'),
      ('event-a-unmapped', 'shop-a', NULL, 'integration-a', 'payos', 'reference-a0',
        'payload-a0', 1, 'identity_mismatch', 'rejected', '${NOW}', '${NOW}'),
      ('event-b1', 'shop-b', 'attempt-b1', 'integration-b', 'payos', 'reference-b1',
        'payload-b1', 1, 'paid_exact', 'processed', '${NOW}', '${NOW}');

    UPDATE payment_attempts SET paid_event_id = 'event-a1' WHERE id = 'attempt-a1';
    UPDATE payment_attempts SET paid_event_id = 'event-a2' WHERE id = 'attempt-a2';
    UPDATE payment_attempts SET paid_event_id = 'event-b1' WHERE id = 'attempt-b1';

    INSERT INTO payment_exceptions (
      id, shop_id, order_id, payment_attempt_id, type, status,
      safe_evidence_json, created_at
    ) VALUES
      ('exception-a1', 'shop-a', 'order-a1', 'attempt-a1', 'manual_review', 'open',
        '{}', '${NOW}'),
      ('exception-b1', 'shop-b', 'order-b1', 'attempt-b1', 'manual_review', 'open',
        '{}', '${NOW}');
  `);
}

function snapshot(database: DatabaseSync): Record<string, unknown[]> {
  return Object.fromEntries([
    "payment_integrations",
    "payment_credentials",
    "payment_attempts",
    "payment_events",
    "payment_exceptions",
    "payment_provider_connections",
    "payment_provider_connection_capabilities",
    "payment_provider_connection_currencies",
    "payment_provider_connection_methods",
  ].map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

function insertAttempt(database: DatabaseSync, input: {
  credentialId: string;
  id: string;
  integrationId: string;
  orderId: string;
  orderCode: number;
  shopId: string;
}): void {
  database.prepare(`
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency,
      expected_description, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'payos', ?, 'pending', 1000, 'VND', 'PAY TEST',
      '2026-07-30T00:00:00.000Z', ?, ?)
  `).run(
    input.id,
    `public-${input.id}`,
    input.shopId,
    input.orderId,
    input.integrationId,
    input.credentialId,
    input.orderCode,
    NOW,
    NOW,
  );
}

describe("legacy PayOS tenant guards migration", () => {
  it("preserves valid legacy and provider-projection rows", () => {
    const database = createPreGuardDatabase();
    const before = snapshot(database);

    applyMigration(database, 37);

    expect(snapshot(database)).toEqual(before);
    expect(database.prepare(`
      SELECT payment_attempt_id AS paymentAttemptId
      FROM payment_events WHERE id = 'event-a-unmapped'
    `).get()).toEqual({ paymentAttemptId: null });
    expect(database.prepare(`PRAGMA index_info('idx_payment_attempts_shop_integration_scope')`).all()
      .map((entry) => String(entry.name)))
      .toEqual(["shop_id", "integration_id", "provider", "credential_id", "order_id", "id"]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects cross-tenant inserts and updates while preserving valid rotation ordering", () => {
    const database = createPreGuardDatabase();
    applyMigration(database, 37);

    database.exec(`
      INSERT INTO payment_integrations (
        id, public_id, webhook_public_id, shop_id, provider, status,
        webhook_status, created_at, updated_at
      ) VALUES ('integration-c', 'integration-public-c', 'webhook-c', 'shop-c',
        'payos', 'active', 'verified', '${NOW}', '${NOW}')
    `);
    expect(() => database.prepare(`
      UPDATE payment_integrations SET active_credential_id = 'credential-b'
      WHERE id = 'integration-c'
    `).run()).toThrow(/payment_integration_active_credential_mismatch/u);
    expect(() => database.prepare(`
      UPDATE payment_integrations SET active_credential_id = 'credential-b'
      WHERE id = 'integration-a'
    `).run()).toThrow(/payment_integration_active_credential_mismatch/u);

    expect(() => { database.exec(`
      INSERT INTO payment_credentials (
        id, shop_id, integration_id, provider, status, version, key_version,
        client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
        api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES ('credential-cross', 'shop-a', 'integration-b', 'payos', 'pending',
        3, 'v1', 'client-x', 'iv-client-x', 'api-x', 'iv-api-x', 'checksum-x',
        'iv-checksum-x', 'credential-fingerprint-x', 'user-a', '${NOW}')
    `); }).toThrow(/payment_credential_integration_scope_mismatch/u);
    expect(() => database.prepare(`
      UPDATE payment_credentials SET shop_id = 'shop-b'
      WHERE id = 'credential-a-pending'
    `).run()).toThrow(/payment_credential_integration_scope_mismatch/u);

    expect(() => { insertAttempt(database, {
      credentialId: "credential-a",
      id: "attempt-order-cross",
      integrationId: "integration-a",
      orderCode: 3001,
      orderId: "order-b1",
      shopId: "shop-a",
    }); }).toThrow(/payment_attempt_order_scope_mismatch/u);
    expect(() => { insertAttempt(database, {
      credentialId: "credential-b",
      id: "attempt-integration-cross",
      integrationId: "integration-b",
      orderCode: 3002,
      orderId: "order-a1",
      shopId: "shop-a",
    }); }).toThrow(/payment_attempt_(?:integration|credential)_scope_mismatch/u);
    expect(() => database.prepare(`
      UPDATE payment_attempts SET credential_id = 'credential-b'
      WHERE id = 'attempt-a1'
    `).run()).toThrow(/payment_attempt_credential_scope_mismatch/u);
    expect(() => database.prepare(`
      UPDATE payment_attempts SET paid_event_id = 'event-a2'
      WHERE id = 'attempt-a1'
    `).run()).toThrow(/payment_attempt_paid_event_scope_mismatch/u);

    expect(() => { database.exec(`
      INSERT INTO payment_events (
        id, shop_id, payment_attempt_id, integration_id, provider,
        provider_event_reference, payload_hash, signature_verified,
        normalized_state, process_result, received_at
      ) VALUES ('event-cross', 'shop-a', 'attempt-b1', 'integration-a', 'payos',
        'reference-cross', 'payload-cross', 1, 'pending', 'received', '${NOW}')
    `); }).toThrow(/payment_event_attempt_scope_mismatch/u);
    expect(() => database.prepare(`
      UPDATE payment_events SET integration_id = 'integration-b'
      WHERE id = 'event-a-unmapped'
    `).run()).toThrow(/payment_event_integration_scope_mismatch/u);
    expect(() => database.prepare(`
      UPDATE payment_events SET payment_attempt_id = 'attempt-a2'
      WHERE id = 'event-a1'
    `).run()).toThrow(/payment_attempt_paid_event_scope_mismatch/u);

    expect(() => { database.exec(`
      INSERT INTO payment_exceptions (
        id, shop_id, order_id, payment_attempt_id, type, status,
        safe_evidence_json, created_at
      ) VALUES ('exception-cross', 'shop-b', 'order-b1', 'attempt-a1',
        'manual_review', 'open', '{}', '${NOW}')
    `); }).toThrow(/payment_exception_attempt_scope_mismatch/u);
    expect(() => database.prepare(`
      UPDATE payment_exceptions SET order_id = 'order-a2'
      WHERE id = 'exception-a1'
    `).run()).toThrow(/payment_exception_attempt_scope_mismatch/u);

    database.prepare(`
      UPDATE payment_credentials SET status = 'grace', grace_ends_at = ?
      WHERE id = 'credential-a'
    `).run("2026-07-30T00:00:00.000Z");
    expect(database.prepare(`
      SELECT active_credential_id AS activeCredentialId
      FROM payment_integrations WHERE id = 'integration-a'
    `).get()).toEqual({ activeCredentialId: null });
    database.prepare(`
      UPDATE payment_credentials SET status = 'active', grace_ends_at = NULL
      WHERE id = 'credential-a'
    `).run();
    database.prepare(`
      UPDATE payment_integrations SET active_credential_id = 'credential-a'
      WHERE id = 'integration-a'
    `).run();
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("fails deterministically when legacy rows already cross a tenant boundary", () => {
    const database = createPreGuardDatabase();
    database.prepare(`
      UPDATE payment_attempts SET order_id = 'order-b1'
      WHERE id = 'attempt-a1'
    `).run();

    expect(() => { applyMigration(database, 37); })
      .toThrow(/migration_0037_attempts_valid/u);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name = 'payment_attempts_order_insert_guard'
    `).get()).toEqual({ count: 0 });
  });
});
