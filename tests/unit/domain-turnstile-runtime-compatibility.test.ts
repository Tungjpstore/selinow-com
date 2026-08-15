import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

function createDatabase(beforeRuntimeGuard?: (database: DatabaseSync) => void): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE shops (
      id TEXT PRIMARY KEY,
      canonical_domain_id TEXT,
      readiness_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE shop_domains (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL REFERENCES shops(id),
      hostname_normalized TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      is_primary INTEGER NOT NULL,
      hostname_status TEXT,
      ssl_status TEXT,
      dns_status TEXT,
      validation_metadata_json TEXT NOT NULL CHECK (json_valid(validation_metadata_json)),
      next_check_at TEXT,
      last_safe_error_code TEXT,
      delete_requested_at TEXT,
      deleted_at TEXT,
      ownership_verified_at TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX idx_shop_domains_one_primary
      ON shop_domains(shop_id) WHERE is_primary = 1 AND deleted_at IS NULL;
    INSERT INTO shops VALUES
      ('shop-a', 'custom-a', 1, '2026-08-01T00:00:00.000Z'),
      ('shop-b', 'platform-b', 1, '2026-08-01T00:00:00.000Z');
    INSERT INTO shop_domains VALUES
      ('platform-a', 'shop-a', 'seller-a.selinow.com', 'platform_subdomain', 'active', 0, NULL, NULL, NULL, '{}', NULL, NULL, NULL, NULL, NULL, 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('custom-a', 'shop-a', 'shop.customer.com', 'custom', 'active', 1, 'active', 'active', 'active', '{}', NULL, NULL, NULL, NULL, '2026-07-01T00:00:00.000Z', 2, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('platform-b', 'shop-b', 'seller-b.selinow.com', 'platform_subdomain', 'active', 1, NULL, NULL, NULL, '{}', NULL, NULL, NULL, NULL, NULL, 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
  `);
  database.exec(readFileSync("migrations/0092_custom_domain_turnstile_admission.sql", "utf8"));
  beforeRuntimeGuard?.(database);
  database.exec(readFileSync("migrations/0093_custom_domain_turnstile_runtime_guard.sql", "utf8"));
  return database;
}

type AdmissionEvidence = {
  checkedAt: string | null;
  hostname: string;
  mode: string;
  source: string;
  status: string;
};

function admittedMetadata(overrides: Partial<AdmissionEvidence> = {}): string {
  return JSON.stringify({
    turnstile: {
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      hostname: "shop.customer.com",
      mode: "operator_managed",
      source: "cloudflare_widget_domains",
      status: "active",
      ...overrides,
    },
  });
}

describe("0093 custom-domain old-runtime compatibility guard", () => {
  it("blocks the old provider transition from undoing 0092 demotion", () => {
    const database = createDatabase();
    expect(() => database.prepare(`
      UPDATE shop_domains
      SET status = 'active', hostname_status = 'active', ssl_status = 'active', dns_status = 'active',
        validation_metadata_json = '{"dns":{"observedTargets":["customers.selinow.com"]}}'
      WHERE id = 'custom-a'
    `).run()).toThrow(/custom_domain_turnstile_admission_required/u);

    expect(database.prepare("SELECT status, is_primary AS isPrimary FROM shop_domains WHERE id = 'custom-a'").get())
      .toEqual({ isPrimary: 0, status: "validating" });
    expect(database.prepare("SELECT canonical_domain_id AS canonicalDomainId FROM shops WHERE id = 'shop-a'").get())
      .toEqual({ canonicalDomainId: "platform-a" });
  });

  it("allows the new runtime only after exact checked admission evidence is persisted", () => {
    const database = createDatabase();
    expect(database.prepare(`
      UPDATE shop_domains
      SET status = 'active', hostname_status = 'active', ssl_status = 'active', dns_status = 'active',
        validation_metadata_json = ?, last_safe_error_code = NULL
      WHERE id = 'custom-a'
    `).run(admittedMetadata()).changes).toBe(1);
    expect(database.prepare("UPDATE shop_domains SET is_primary = 0 WHERE id = 'platform-a'").run().changes).toBe(1);
    expect(database.prepare("UPDATE shop_domains SET is_primary = 1 WHERE id = 'custom-a'").run().changes).toBe(1);
    expect(database.prepare("UPDATE shops SET canonical_domain_id = 'custom-a' WHERE id = 'shop-a'").run().changes).toBe(1);
  });

  it("rejects hostname mismatch, unchecked evidence and cross-tenant canonical selection", () => {
    const database = createDatabase();
    for (const metadata of [
      admittedMetadata({ hostname: "other.customer.com" }),
      admittedMetadata({ checkedAt: null }),
      admittedMetadata({ checkedAt: "not-a-timestamp" }),
      admittedMetadata({ checkedAt: new Date(Date.now() - 13 * 60 * 60_000).toISOString() }),
      admittedMetadata({ checkedAt: new Date(Date.now() + 5 * 60_000).toISOString() }),
    ]) {
      expect(() => database.prepare(`
        UPDATE shop_domains
        SET status = 'active', hostname_status = 'active', ssl_status = 'active', dns_status = 'active',
          validation_metadata_json = ?
        WHERE id = 'custom-a'
      `).run(metadata)).toThrow(/custom_domain_turnstile_admission_required/u);
    }

    database.prepare(`
      UPDATE shop_domains
      SET status = 'active', hostname_status = 'active', ssl_status = 'active', dns_status = 'active',
        validation_metadata_json = ?
      WHERE id = 'custom-a'
    `).run(admittedMetadata());
    database.prepare("UPDATE shop_domains SET is_primary = 0 WHERE id = 'platform-a'").run();
    database.prepare("UPDATE shop_domains SET is_primary = 1 WHERE id = 'custom-a'").run();
    database.prepare("UPDATE shops SET canonical_domain_id = 'custom-a' WHERE id = 'shop-a'").run();
    expect(() => database.prepare("UPDATE shops SET canonical_domain_id = 'custom-a' WHERE id = 'shop-b'").run())
      .toThrow(/custom_domain_canonical_not_ready/u);
  });

  it("keeps platform-domain activation and canonical routing unchanged", () => {
    const database = createDatabase();
    expect(database.prepare("UPDATE shop_domains SET status = 'active', is_primary = 1 WHERE id = 'platform-a'").run().changes).toBe(1);
    expect(database.prepare("UPDATE shops SET canonical_domain_id = 'platform-a' WHERE id = 'shop-a'").run().changes).toBe(1);
  });

  it("repairs an invalid old-runtime reactivation written between 0092 and 0093", () => {
    const database = createDatabase((betweenMigrations) => {
      betweenMigrations.prepare("UPDATE shop_domains SET is_primary = 0 WHERE id = 'platform-a'").run();
      betweenMigrations.prepare(`
        UPDATE shop_domains
        SET status = 'active', is_primary = 1, hostname_status = 'active', ssl_status = 'active', dns_status = 'active',
          validation_metadata_json = '{"dns":{"observedTargets":["customers.selinow.com"]}}'
        WHERE id = 'custom-a'
      `).run();
      betweenMigrations.prepare("UPDATE shops SET canonical_domain_id = 'custom-a' WHERE id = 'shop-a'").run();
    });

    expect(database.prepare("SELECT status, is_primary AS isPrimary FROM shop_domains WHERE id = 'custom-a'").get())
      .toEqual({ isPrimary: 0, status: "validating" });
    expect(database.prepare("SELECT is_primary AS isPrimary FROM shop_domains WHERE id = 'platform-a'").get())
      .toEqual({ isPrimary: 1 });
    expect(database.prepare("SELECT canonical_domain_id AS canonicalDomainId FROM shops WHERE id = 'shop-a'").get())
      .toEqual({ canonicalDomainId: "platform-a" });
  });

  it("preserves a genuinely fresh exact custom primary across the compatibility migration", () => {
    const database = createDatabase((betweenMigrations) => {
      betweenMigrations.prepare("UPDATE shop_domains SET is_primary = 0 WHERE id = 'platform-a'").run();
      betweenMigrations.prepare(`
        UPDATE shop_domains
        SET status = 'active', is_primary = 1, hostname_status = 'active', ssl_status = 'active', dns_status = 'active',
          validation_metadata_json = ?
        WHERE id = 'custom-a'
      `).run(admittedMetadata());
      betweenMigrations.prepare("UPDATE shops SET canonical_domain_id = 'custom-a' WHERE id = 'shop-a'").run();
    });

    expect(database.prepare("SELECT status, is_primary AS isPrimary FROM shop_domains WHERE id = 'custom-a'").get())
      .toEqual({ isPrimary: 1, status: "active" });
    expect(database.prepare("SELECT canonical_domain_id AS canonicalDomainId FROM shops WHERE id = 'shop-a'").get())
      .toEqual({ canonicalDomainId: "custom-a" });
  });

  it("blocks active inserts and makes domain identity immutable", () => {
    const database = createDatabase();
    expect(() => database.prepare(`
      INSERT INTO shop_domains (
        id, shop_id, hostname_normalized, type, status, is_primary,
        hostname_status, ssl_status, dns_status, validation_metadata_json,
        next_check_at, last_safe_error_code, delete_requested_at, deleted_at,
        ownership_verified_at, version, created_at, updated_at
      ) VALUES (
        'custom-new', 'shop-a', 'new.customer.com', 'custom', 'active', 0,
        'active', 'active', 'active', '{}', NULL, NULL, NULL, NULL,
        '2026-08-09T00:00:00.000Z', 1, '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
      )
    `).run()).toThrow(/custom_domain_turnstile_admission_required/u);
    expect(() => database.prepare("UPDATE shop_domains SET shop_id = 'shop-b' WHERE id = 'custom-a'").run())
      .toThrow(/shop_domain_identity_immutable/u);
    expect(() => database.prepare("UPDATE shop_domains SET hostname_normalized = 'moved.customer.com' WHERE id = 'custom-a'").run())
      .toThrow(/shop_domain_identity_immutable/u);
  });
});
