import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

function applyMigrationsThrough(database: DatabaseSync, lastMigration: string): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && name < lastMigration)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function seedLegacyCustomDomainWithPayment(database: DatabaseSync): void {
  const now = "2026-07-26T00:00:00.000Z";
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan_business', 'business', 'Business', '{"customDomain":true}', '{"customDomains":3}', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-a', 'owner@example.com', 'Owner', 'active', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, canonical_domain_id, readiness_version, created_at, updated_at)
    VALUES ('shop-a', 'shop_public_a', 'seller', 'Seller', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 'dom-legacy-custom', 1, '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-a', 'user-a', 'owner', 'active', '${now}', '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
    VALUES ('sub-a', 'shop-a', 'plan_business', 'active', '${now}', '${now}');
    INSERT INTO shop_domains (id, shop_id, hostname_normalized, type, status, is_primary, cloudflare_hostname_id,
      hostname_status, ssl_status, validation_metadata_json, activated_at, created_at, updated_at,
      dns_status, next_check_at, check_attempts, version)
    VALUES ('dom-platform', 'shop-a', 'seller.staging.selinow.com', 'platform_subdomain', 'active', 0, NULL,
      NULL, NULL, '{}', '${now}', '${now}', '${now}', NULL, NULL, 0, 1);
    INSERT INTO shop_domains (id, shop_id, hostname_normalized, type, status, is_primary, cloudflare_hostname_id,
      hostname_status, ssl_status, validation_metadata_json, activated_at, created_at, updated_at,
      dns_status, next_check_at, check_attempts, version)
    VALUES ('dom-legacy-custom', 'shop-a', 'legacy.customer.com', 'custom', 'active', 1, 'cf-legacy',
      'active', 'active', '{"dns":"active"}', '${now}', '${now}', '${now}', 'active', NULL, 0, 1);
    UPDATE shops SET canonical_domain_id = 'dom-legacy-custom' WHERE id = 'shop-a';
    INSERT INTO shop_settings (shop_id, branding_json, storefront_json, updated_at)
    VALUES ('shop-a', '{}', '{}', '${now}');
    INSERT INTO orders (id, public_id, shop_id, order_number, source_channel, status, payment_status, fulfillment_status,
      subtotal_minor, total_minor, currency, locale, checkout_subject_hash, order_token_hash, expires_at, created_at, updated_at)
    VALUES ('order-a', 'order_public_a', 'shop-a', '1001', 'web', 'pending_payment', 'unpaid', 'unfulfilled',
      1000, 1000, 'VND', 'vi', 'subject-hash', 'token-hash', '${now}', '${now}', '${now}');
    INSERT INTO payment_integrations (id, public_id, webhook_public_id, shop_id, provider, status, webhook_status, created_at, updated_at)
    VALUES ('integration-a', 'payint-a', 'webhook-a', 'shop-a', 'payos', 'active', 'verified', '${now}', '${now}');
    INSERT INTO payment_credentials (id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64, api_key_iv_b64,
      checksum_key_ciphertext_b64, checksum_key_iv_b64, credential_fingerprint, created_by_user_id, created_at)
    VALUES ('credential-a', 'shop-a', 'integration-a', 'payos', 'active', 1, 'v1',
      'client', 'client-iv', 'api', 'api-iv', 'checksum', 'checksum-iv', 'fingerprint', 'user-a', '${now}');
    INSERT INTO payment_attempts (id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency, expected_description, expires_at, created_at, updated_at,
      checkout_domain_id)
    VALUES ('attempt-a', 'attempt_public_a', 'shop-a', 'order-a', 'integration-a', 'credential-a', 'payos',
      1001, 'pending', 1000, 'VND', 'Seller order', '${now}', '${now}', '${now}', 'dom-legacy-custom');
  `);
}

describe("custom-domain ownership migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrationsThrough(database, "0018_");
    seedLegacyCustomDomainWithPayment(database);
  });

  afterEach(() => {
    database.close();
  });

  it("tombstones legacy custom rows while preserving payment references and foreign keys", () => {
    database.exec(readFileSync(join(process.cwd(), "migrations", "0018_custom_domain_ownership_claims.sql"), "utf8"));

    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("SELECT checkout_domain_id FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ checkout_domain_id: "dom-legacy-custom" });
    expect(database.prepare("SELECT hostname_normalized, status, ownership_verified_at, cloudflare_hostname_id FROM shop_domains WHERE id = 'dom-legacy-custom'").get()).toEqual({
      hostname_normalized: "legacy-unverified-dom-legacy-custom.invalid",
      status: "deleted",
      ownership_verified_at: null,
      cloudflare_hostname_id: null,
    });
    expect(database.prepare("SELECT hostname_normalized, status, is_primary FROM shop_domains WHERE id = 'dom-platform'").get()).toEqual({
      hostname_normalized: "seller.staging.selinow.com",
      status: "active",
      is_primary: 1,
    });
    expect(database.prepare("SELECT canonical_domain_id FROM shops WHERE id = 'shop-a'").get()).toEqual({ canonical_domain_id: "dom-platform" });

    const foreignKeys = database.prepare("PRAGMA foreign_key_list(payment_attempts)").all() as Array<Record<string, unknown>>;
    expect(foreignKeys).toContainEqual(expect.objectContaining({ from: "checkout_domain_id", table: "shop_domains", on_delete: "RESTRICT" }));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_domain_checkout_refs_0018'").get()).toBeUndefined();
  });
});
