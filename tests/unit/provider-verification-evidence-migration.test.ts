import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-08-02T12:00:00.000Z";
const CREDENTIAL_FINGERPRINT = "A".repeat(43);
const EVIDENCE_REFERENCE = "B".repeat(43);

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-evidence', 'plan-evidence', 'Evidence plan', '{}', '{}', '${NOW}', '${NOW}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES
      ('user-evidence-owner', 'owner-evidence@example.com', 'Evidence owner', 'active', '${NOW}', '${NOW}'),
      ('user-evidence-outsider', 'outsider-evidence@example.com', 'Evidence outsider', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-evidence', 'shop-evidence-public', 'shop-evidence', 'Evidence shop', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-evidence', 'user-evidence-owner', 'owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
    VALUES ('subscription-evidence', 'shop-evidence', 'plan-evidence', 'active', '${NOW}', '${NOW}');
    INSERT INTO shop_channels (id, shop_id, channel_code, status, settings_json, version, created_at, updated_at)
    VALUES ('shop-channel-evidence', 'shop-evidence', 'whatsapp.cloud', 'enabled', '{}', 1, '${NOW}', '${NOW}');
    INSERT INTO channel_connections (
      id, public_id, shop_id, shop_channel_id, provider_code, status,
      settings_json, version, created_at, updated_at
    ) VALUES
      ('connection-evidence', 'connection-evidence-public', 'shop-evidence', 'shop-channel-evidence', 'whatsapp.cloud', 'pending', '{}', 1, '${NOW}', '${NOW}'),
      ('connection-empty', 'connection-empty-public', 'shop-evidence', 'shop-channel-evidence', 'whatsapp.cloud', 'pending', '{}', 1, '${NOW}', '${NOW}');
    INSERT INTO channel_credentials (
      id, shop_id, connection_id, provider_code, status, version, key_version,
      credential_envelope_ciphertext_b64, credential_envelope_iv_b64,
      credential_fingerprint, created_by_user_id, created_at
    ) VALUES (
      'credential-evidence', 'shop-evidence', 'connection-evidence', 'whatsapp.cloud',
      'pending', 1, 'v1', 'ciphertext-evidence-1', 'iv-evidence-1',
      '${CREDENTIAL_FINGERPRINT}', 'user-evidence-owner', '${NOW}'
    );
  `);
  return database;
}

function insertEvidence(database: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const input = {
    id: "evidence-row-001",
    shopId: "shop-evidence",
    connectionId: "connection-evidence",
    providerCode: "whatsapp.cloud",
    credentialVersion: 1,
    credentialFingerprint: CREDENTIAL_FINGERPRINT,
    verificationKind: "webhook",
    evidenceReference: EVIDENCE_REFERENCE,
    providerIdentityFingerprint: null,
    safeMetadataJson: "{}",
    status: "observed",
    verifiedAt: "2026-08-02T11:00:00.000Z",
    expiresAt: "2026-08-03T11:00:00.000Z",
    reviewedByUserId: null,
    reviewedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
  database.prepare(`
    INSERT INTO channel_provider_verification_evidence (
      id, shop_id, connection_id, provider_code, credential_version,
      credential_fingerprint, verification_kind, evidence_reference,
      provider_identity_fingerprint, safe_metadata_json, status, verified_at,
      expires_at, reviewed_by_user_id, reviewed_at, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.shopId, input.connectionId, input.providerCode,
    input.credentialVersion, input.credentialFingerprint, input.verificationKind,
    input.evidenceReference, input.providerIdentityFingerprint, input.safeMetadataJson,
    input.status, input.verifiedAt, input.expiresAt, input.reviewedByUserId,
    input.reviewedAt, input.createdAt, input.updatedAt, input.version,
  );
}

describe("provider verification evidence migration", () => {
  it("registers tenant-leading indexes and the forward scope guards", () => {
    const database = createDatabase();
    expect(database.prepare("PRAGMA table_info(channel_provider_verification_evidence)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "shop_id", notnull: 1 }),
        expect.objectContaining({ name: "connection_id", notnull: 1 }),
        expect.objectContaining({ name: "credential_version", notnull: 1 }),
      ]),
    );
    expect(database.prepare("SELECT name FROM pragma_index_list('channel_provider_verification_evidence') ORDER BY name").all()).toEqual(
      expect.arrayContaining([
        { name: "idx_channel_provider_verification_connection" },
        { name: "idx_channel_provider_verification_expiry" },
        { name: "idx_channel_provider_verification_shop_status" },
      ]),
    );
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'channel_provider_verification_%' ORDER BY name").all()).toEqual(
      expect.arrayContaining([
        { name: "channel_provider_verification_credential_scope_insert_guard" },
        { name: "channel_provider_verification_reviewer_scope_insert_guard" },
        { name: "channel_provider_verification_reviewer_scope_guard" },
      ]),
    );
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'channel_connections_identity_immutable'").get()).toEqual({ name: "channel_connections_identity_immutable" });
  });

  it("rejects forged review metadata and phantom credential lineage on direct D1 inserts", () => {
    const database = createDatabase();
    expect(() => {
      insertEvidence(database, {
        id: "evidence-forged-review",
        status: "reviewed",
        reviewedByUserId: "user-evidence-outsider",
        reviewedAt: "2026-08-02T11:01:00.000Z",
      });
    }).toThrow(/channel_provider_verification_reviewer_scope_mismatch/u);
    expect(() => {
      insertEvidence(database, {
        id: "evidence-phantom-credential",
        credentialVersion: 2,
        credentialFingerprint: "C".repeat(43),
      });
    }).toThrow(/channel_provider_verification_credential_scope_mismatch/u);
  });

  it("allows a same-tenant reviewed row and blocks channel identity drift", () => {
    const database = createDatabase();
    insertEvidence(database, {
      status: "reviewed",
      reviewedByUserId: "user-evidence-owner",
      reviewedAt: "2026-08-02T11:01:00.000Z",
    });
    expect(database.prepare("SELECT status, reviewed_by_user_id AS reviewer FROM channel_provider_verification_evidence WHERE id = 'evidence-row-001'").get()).toEqual({ status: "reviewed", reviewer: "user-evidence-owner" });
    expect(() => database.prepare("UPDATE channel_connections SET provider_code = 'discord.bot' WHERE id = 'connection-empty'").run()).toThrow(/channel_connection_identity_immutable/u);
    expect(() => database.prepare("UPDATE channel_connections SET shop_channel_id = 'missing-channel' WHERE id = 'connection-empty'").run()).toThrow(/channel_connection_identity_immutable/u);
  });
});
