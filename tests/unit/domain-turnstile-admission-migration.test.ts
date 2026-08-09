import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

describe("0092 custom-domain Turnstile admission migration", () => {
  it("demotes legacy custom routing and restores only a safe platform fallback", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE shops (
        id TEXT PRIMARY KEY,
        canonical_domain_id TEXT,
        readiness_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE shop_domains (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
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
        ('shop-a', 'custom-a', 4, '2026-08-01T00:00:00.000Z'),
        ('shop-b', 'custom-b', 2, '2026-08-01T00:00:00.000Z'),
        ('shop-c', 'platform-c', 3, '2026-08-01T00:00:00.000Z');
      INSERT INTO shop_domains VALUES
        ('platform-a', 'shop-a', 'seller-a.selinow.com', 'platform_subdomain', 'active', 0, NULL, NULL, NULL, '{}', NULL, NULL, NULL, NULL, NULL, 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('custom-a', 'shop-a', 'shop.customer.com', 'custom', 'active', 1, 'active', 'active', 'active', '{"dns":{"observedTargets":["customers.selinow.com"]}}', NULL, NULL, NULL, NULL, '2026-07-02T00:00:00.000Z', 7, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
        ('custom-b', 'shop-b', 'buy.customer.com', 'custom', 'active', 1, 'active', 'active', 'active', '{}', NULL, NULL, NULL, NULL, '2026-07-02T00:00:00.000Z', 3, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
        ('platform-c', 'shop-c', 'seller-c.selinow.com', 'platform_subdomain', 'active', 1, NULL, NULL, NULL, '{}', NULL, NULL, NULL, NULL, NULL, 2, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('deleted-c', 'shop-c', 'old.customer.com', 'custom', 'deleted', 0, 'deleted', 'deleted', 'error', '{}', NULL, NULL, NULL, '2026-07-30T00:00:00.000Z', '2026-07-02T00:00:00.000Z', 5, '2026-07-02T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
    `);

    database.exec(readFileSync("migrations/0092_custom_domain_turnstile_admission.sql", "utf8"));

    expect(database.prepare(`
      SELECT status, is_primary AS isPrimary, last_safe_error_code AS errorCode,
        json_extract(validation_metadata_json, '$.turnstile.hostname') AS turnstileHostname,
        json_extract(validation_metadata_json, '$.turnstile.status') AS turnstileStatus,
        next_check_at IS NOT NULL AS retryScheduled
      FROM shop_domains WHERE id = 'custom-a'
    `).get()).toEqual({
      errorCode: "domain_turnstile_admission_pending",
      isPrimary: 0,
      retryScheduled: 1,
      status: "validating",
      turnstileHostname: "shop.customer.com",
      turnstileStatus: "pending",
    });
    expect(database.prepare("SELECT is_primary AS isPrimary FROM shop_domains WHERE id = 'platform-a'").get()).toEqual({ isPrimary: 1 });
    expect(database.prepare("SELECT canonical_domain_id AS canonicalDomainId FROM shops WHERE id = 'shop-a'").get()).toEqual({ canonicalDomainId: "platform-a" });
    expect(database.prepare("SELECT canonical_domain_id AS canonicalDomainId FROM shops WHERE id = 'shop-b'").get()).toEqual({ canonicalDomainId: null });
    expect(database.prepare("SELECT canonical_domain_id AS canonicalDomainId, readiness_version AS readinessVersion FROM shops WHERE id = 'shop-c'").get()).toEqual({ canonicalDomainId: "platform-c", readinessVersion: 3 });
    expect(database.prepare("SELECT validation_metadata_json AS metadata, version FROM shop_domains WHERE id = 'deleted-c'").get()).toEqual({ metadata: "{}", version: 5 });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});
