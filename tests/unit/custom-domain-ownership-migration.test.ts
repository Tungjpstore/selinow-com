import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function applyMigrationsThrough(database: DatabaseSync, lastMigration: string): void {
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(join(process.cwd(), "migrations")).filter((entry) => entry.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", name), "utf8"));
    if (name === lastMigration) break;
  }
}

describe("custom-domain ownership migration", () => {
  it("tombstones legacy customs and preserves payment references through the rebuild", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrationsThrough(database, "0017_auth_request_admissions.sql");
    database.exec(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('user_1', 'owner@example.test', 'Owner', 'active', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, created_at, updated_at)
      VALUES ('shop_1', 'shop_public_1', 'shop-1', 'Shop 1', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');
      INSERT INTO shop_domains (
        id, shop_id, hostname_normalized, type, status, is_primary, cloudflare_hostname_id,
        hostname_status, ssl_status, validation_metadata_json, activated_at, created_at, updated_at,
        dns_status, check_attempts, version
      ) VALUES
        ('dom_platform', 'shop_1', 'shop-1.staging.selinow.com', 'platform_subdomain', 'active', 0, NULL,
         NULL, NULL, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', NULL, 0, 1),
        ('dom_custom', 'shop_1', 'legacy.example.com', 'custom', 'active', 1, 'cf_legacy',
         'active', 'active', '{"provider":"legacy"}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', 'active', 0, 1);
      UPDATE shops SET canonical_domain_id = 'dom_custom' WHERE id = 'shop_1';
      INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
      VALUES ('customer_1', 'shop_1', 'buyer@example.test', 'Buyer', 'vi', 'active', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');
      INSERT INTO orders (
        id, public_id, shop_id, customer_id, order_number, source_channel, status, payment_status,
        fulfillment_status, subtotal_minor, total_minor, currency, locale, checkout_subject_hash,
        order_token_hash, expires_at, created_at, updated_at
      ) VALUES (
        'order_1', 'order_public_1', 'shop_1', 'customer_1', 'ORD-1', 'web', 'pending_payment', 'unpaid',
        'unfulfilled', 1000, 1000, 'VND', 'vi', 'subject', 'token', '2026-07-27T00:00:00.000Z',
        '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'
      );
      INSERT INTO payment_integrations (
        id, public_id, webhook_public_id, shop_id, provider, status, webhook_status, created_at, updated_at
      ) VALUES ('integration_1', 'integration_public_1', 'webhook_public_1', 'shop_1', 'payos', 'active', 'verified', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');
      INSERT INTO payment_credentials (
        id, shop_id, integration_id, provider, status, version, key_version,
        client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
        api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES (
        'credential_1', 'shop_1', 'integration_1', 'payos', 'active', 1, 'v1',
        'x', 'x', 'x', 'x', 'x', 'x', 'fingerprint_1', 'user_1', '2026-07-26T00:00:00.000Z'
      );
      INSERT INTO payment_attempts (
        id, public_id, shop_id, order_id, integration_id, credential_id, provider,
        provider_order_code, state, expected_amount_minor, currency, expected_description,
        expires_at, created_at, updated_at, checkout_domain_id
      ) VALUES (
        'payment_1', 'payment_public_1', 'shop_1', 'order_1', 'integration_1', 'credential_1', 'payos',
        1001, 'pending', 1000, 'VND', 'Shop 1', '2026-07-27T00:00:00.000Z',
        '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', 'dom_custom'
      );
    `);

    database.exec(readFileSync(join(process.cwd(), "migrations", "0018_custom_domain_ownership_claims.sql"), "utf8"));

    const legacy = database.prepare("SELECT hostname_normalized, status, is_primary, cloudflare_hostname_id, hostname_status, ssl_status, dns_status, ownership_verified_at FROM shop_domains WHERE id = 'dom_custom'").get() as Record<string, unknown>;
    expect(legacy).toMatchObject({
      hostname_normalized: "legacy-unverified-dom_custom.invalid",
      status: "deleted",
      is_primary: 0,
      cloudflare_hostname_id: null,
      hostname_status: null,
      ssl_status: null,
      dns_status: null,
      ownership_verified_at: null,
    });
    expect(database.prepare("SELECT hostname_normalized, is_primary FROM shop_domains WHERE id = 'dom_platform'").get()).toMatchObject({
      hostname_normalized: "shop-1.staging.selinow.com",
      is_primary: 1,
    });
    expect(database.prepare("SELECT checkout_domain_id FROM payment_attempts WHERE id = 'payment_1'").get()).toEqual({ checkout_domain_id: "dom_custom" });
    expect(database.prepare("SELECT canonical_domain_id FROM shops WHERE id = 'shop_1'").get()).toEqual({ canonical_domain_id: "dom_platform" });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA foreign_key_list(payment_attempts)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "shop_domains", from: "checkout_domain_id", to: "id" }),
    ]));
    database.close();
  });
});
