import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-30T07:00:00.000Z";
const LATER = "2026-07-30T07:01:00.000Z";
const HASH_A = "a".repeat(43);
const HASH_B = "b".repeat(43);
const databases: DatabaseSync[] = [];

function applyMigrations(database: DatabaseSync, maximumMigration: number): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    if (Number.parseInt(filename.slice(0, 4), 10) > maximumMigration) break;
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function createDatabase(maximumMigration: number): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, maximumMigration);
  return database;
}

function applyMigration(database: DatabaseSync, filename: string): void {
  database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
}

function seedShop(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (
      id, email_normalized, display_name, status, created_at, updated_at
    ) VALUES ('user-a', 'owner@example.test', 'Owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES ('shop-a', 'shop-public-a', 'shop-a', 'Shop A', 'active',
      'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
  `);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("0051 generated-license encryption rotation", () => {
  it("preserves existing runs and expands the resumable rotation ledgers", () => {
    const database = createDatabase(50);
    seedShop(database);
    database.exec(`
      INSERT INTO encryption_rotation_runs (
        id, shop_id, scope_key, key_family, source_key_version,
        target_key_version, status, dry_run, total_items, processed_items,
        failed_items, request_id, created_at, updated_at
      ) VALUES ('rotation-legacy', 'shop-a', 'shop:shop-a', 'inventory',
        'v1', 'v2', 'completed', 1, 1, 0, 0, 'request-legacy', '${NOW}', '${NOW}');
      INSERT INTO encryption_rotation_items (
        id, run_id, shop_id, resource_type, resource_id, status, attempts,
        source_key_version, target_key_version, version, created_at, updated_at
      ) VALUES ('rotation-item-legacy', 'rotation-legacy', 'shop-a',
        'inventory_key', 'inventory-key-a', 'skipped', 1, 'v1', 'v2', 1,
        '${NOW}', '${NOW}');
    `);

    applyMigration(database, "0051_generated_license_rotation.sql");

    expect(database.prepare(`
      SELECT key_family AS keyFamily, status FROM encryption_rotation_runs
      WHERE id = 'rotation-legacy'
    `).get()).toEqual({ keyFamily: "inventory", status: "completed" });
    expect(database.prepare(`
      SELECT resource_type AS resourceType, status FROM encryption_rotation_items
      WHERE id = 'rotation-item-legacy'
    `).get()).toEqual({ resourceType: "inventory_key", status: "skipped" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    database.exec(`
      INSERT INTO encryption_rotation_runs (
        id, shop_id, scope_key, key_family, source_key_version,
        target_key_version, status, dry_run, total_items, processed_items,
        failed_items, request_id, created_at, updated_at
      ) VALUES ('rotation-generated', 'shop-a', 'shop:shop-a',
        'generated_license_credentials', 'v1', 'v2', 'paused', 0, 1, 0, 1,
        'request-generated', '${NOW}', '${NOW}');
      INSERT INTO encryption_rotation_items (
        id, run_id, shop_id, resource_type, resource_id, status, attempts,
        source_key_version, target_key_version, last_safe_error_code,
        version, created_at, updated_at
      ) VALUES ('rotation-item-generated', 'rotation-generated', 'shop-a',
        'generated_license_credential', 'credential-a', 'manual_review', 1,
        'v1', 'v2', 'encryption_rotation_manual_review', 1, '${NOW}', '${NOW}');
    `);
    expect(database.prepare(`
      SELECT status, last_safe_error_code AS lastSafeErrorCode
      FROM encryption_rotation_items WHERE id = 'rotation-item-generated'
    `).get()).toEqual({ lastSafeErrorCode: "encryption_rotation_manual_review", status: "manual_review" });
  });

  it("allows only fingerprint-preserving credential rewrites and keeps revoked-to-destroyed deletion", () => {
    const database = createDatabase(51);
    seedShop(database);
    database.exec(`
      INSERT INTO generated_license_provider_connections (
        id, shop_id, provider_code, provider_environment, status,
        external_account_fingerprint, created_by_user_id, created_at, updated_at
      ) VALUES ('connection-a', 'shop-a', 'fake.license', 'sandbox', 'active',
        '${HASH_A}', 'user-a', '${NOW}', '${NOW}');
      INSERT INTO generated_license_provider_credentials (
        id, shop_id, connection_id, provider_code, credential_version, status,
        key_version, endpoint_ciphertext_b64, endpoint_iv_b64,
        credential_ciphertext_b64, credential_iv_b64, endpoint_fingerprint,
        credential_fingerprint, created_by_user_id, activated_at, created_at,
        updated_at, version
      ) VALUES ('credential-a', 'shop-a', 'connection-a', 'fake.license', 1,
        'active', 'v1', 'endpoint-cipher-v1', 'endpoint-iv-v1',
        'credential-cipher-v1', 'credential-iv-v1', '${HASH_A}', '${HASH_B}',
        'user-a', '${NOW}', '${NOW}', '${NOW}', 1);
    `);
    database.exec(`
      UPDATE generated_license_provider_credentials
      SET key_version = 'v2', endpoint_ciphertext_b64 = 'endpoint-cipher-v2',
        endpoint_iv_b64 = 'endpoint-iv-v2',
        credential_ciphertext_b64 = 'credential-cipher-v2',
        credential_iv_b64 = 'credential-iv-v2', version = version + 1,
        updated_at = '${LATER}'
      WHERE id = 'credential-a'
    `);
    expect(database.prepare(`
      SELECT key_version AS keyVersion, endpoint_fingerprint AS endpointFingerprint,
        credential_fingerprint AS credentialFingerprint, version
      FROM generated_license_provider_credentials WHERE id = 'credential-a'
    `).get()).toEqual({
      credentialFingerprint: HASH_B,
      endpointFingerprint: HASH_A,
      keyVersion: "v2",
      version: 2,
    });
    expect(() => {
      database.exec(`
        UPDATE generated_license_provider_credentials
        SET key_version = 'v3', endpoint_ciphertext_b64 = 'endpoint-cipher-v3',
          endpoint_iv_b64 = 'endpoint-iv-v3',
          credential_ciphertext_b64 = 'credential-cipher-v3',
          credential_iv_b64 = 'credential-iv-v3', endpoint_fingerprint = '${HASH_B}',
          version = version + 1, updated_at = '${LATER}'
        WHERE id = 'credential-a'
      `);
    }).toThrow("generated_license_credential_identity_immutable");

    database.exec(`
      UPDATE generated_license_provider_credentials
      SET status = 'revoked', revoked_at = '${LATER}', version = version + 1,
        updated_at = '${LATER}' WHERE id = 'credential-a';
      UPDATE generated_license_provider_credentials
      SET status = 'destroyed', key_version = 'destroyed',
        endpoint_ciphertext_b64 = 'destroyed', endpoint_iv_b64 = 'destroyed',
        credential_ciphertext_b64 = 'destroyed', credential_iv_b64 = 'destroyed',
        endpoint_fingerprint = 'destroyed', credential_fingerprint = 'destroyed',
        version = version + 1, updated_at = '${LATER}'
      WHERE id = 'credential-a';
    `);
    expect(database.prepare(`
      SELECT status, key_version AS keyVersion
      FROM generated_license_provider_credentials WHERE id = 'credential-a'
    `).get()).toEqual({ keyVersion: "destroyed", status: "destroyed" });
  });

  it("allows artifact envelope rotation while preserving fingerprint and deletion transitions", () => {
    const database = createDatabase(51);
    seedShop(database);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER generated_license_artifacts_scope_guard;
      INSERT INTO generated_license_artifacts (
        id, shop_id, request_id, entitlement_id, ordinal, ciphertext_b64,
        iv_b64, key_version, artifact_fingerprint, format, status, created_at
      ) VALUES ('artifact-a', 'shop-a', 'request-a', 'entitlement-a', 1,
        'artifact-cipher-v1', 'artifact-iv-v1', 'v1', '${HASH_A}', 'text',
        'active', '${NOW}');
    `);
    database.exec(`
      UPDATE generated_license_artifacts
      SET ciphertext_b64 = 'artifact-cipher-v2', iv_b64 = 'artifact-iv-v2',
        key_version = 'v2' WHERE id = 'artifact-a'
    `);
    expect(database.prepare(`
      SELECT key_version AS keyVersion, artifact_fingerprint AS artifactFingerprint
      FROM generated_license_artifacts WHERE id = 'artifact-a'
    `).get()).toEqual({ artifactFingerprint: HASH_A, keyVersion: "v2" });
    expect(() => {
      database.exec(`
        UPDATE generated_license_artifacts
        SET ciphertext_b64 = 'replacement-same-key' WHERE id = 'artifact-a'
      `);
    }).toThrow("generated_license_artifact_identity_immutable");

    database.exec(`
      UPDATE generated_license_artifacts
      SET status = 'revoked', revoked_at = '${LATER}' WHERE id = 'artifact-a';
      UPDATE generated_license_artifacts
      SET status = 'destroyed', ciphertext_b64 = 'destroyed', iv_b64 = 'destroyed',
        key_version = 'destroyed', artifact_fingerprint = 'destroyed'
      WHERE id = 'artifact-a';
    `);
    expect(database.prepare(`
      SELECT status, key_version AS keyVersion
      FROM generated_license_artifacts WHERE id = 'artifact-a'
    `).get()).toEqual({ keyVersion: "destroyed", status: "destroyed" });
  });
});
