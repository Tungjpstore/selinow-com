import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { getOnboardingState } from "../../src/lib/onboarding/store";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { publishReadyStorefront } from "../../src/lib/tenants/readiness";

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first(): Promise<unknown> {
    return Promise.resolve(this.database.prepare(this.sql).get(...this.values) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (let version = 1; version <= 10; version += 1) {
    const prefix = String(version).padStart(4, "0");
    const filename = version === 1 ? "platform_foundation"
      : version === 2 ? "tenant_auth_subscription"
        : version === 3 ? "catalog_inventory_orders"
          : version === 4 ? "checkout_idempotency"
            : version === 5 ? "checkout_request_hash"
              : version === 6 ? "payos_payments"
                : version === 7 ? "telegram_multibot"
                  : version === 8 ? "storefront_abuse_controls"
                    : version === 9 ? "custom_domains"
                      : "automated_onboarding";
    database.exec(readFileSync(`migrations/${prefix}_${filename}.sql`, "utf8"));
  }
  database.exec(readFileSync("migrations/0029_storefront_draft_publication.sql", "utf8"));
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  return new SqliteD1(database);
}

function seedReadyShop(database: DatabaseSync): void {
  const now = new Date().toISOString();
  const statements: Array<[string, SQLInputValue[]]> = [
    ["INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)", ["usr_a", "owner@example.com", "Owner", now, now]],
    ["INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)", ["usr_b", "other@example.com", "Other", now, now]],
    ["INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, canonical_domain_id, readiness_version, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', ?, 1, ?, ?)", ["shp_a", "shop_public_a", "seller", "Seller", "dom_a", now, now]],
    ["INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)", ["shp_a", "usr_a", now, now]],
    ["INSERT INTO shop_settings (shop_id, branding_json, storefront_json, order_expiry_minutes, low_stock_threshold, version, updated_at, support_contact, terms_url, privacy_url, refund_policy_url, policy_attestation_version, policy_attested_at, policy_attested_by_user_id) VALUES (?, ?, ?, 30, 5, 1, ?, ?, ?, ?, ?, 1, ?, ?)", ["shp_a", '{"primaryColor":"#176B5B"}', '{"headline":"Draft storefront"}', now, "support@example.com", "https://seller.example/terms", "https://seller.example/privacy", "https://seller.example/refunds", now, "usr_a"]],
    ["INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at) VALUES (?, ?, 'plan_business_v1', 'active', ?, ?)", ["sub_a", "shp_a", now, now]],
    ["INSERT INTO shop_domains (id, shop_id, hostname_normalized, type, status, is_primary, validation_metadata_json, activated_at, created_at, updated_at, dns_status, check_attempts, version) VALUES (?, ?, ?, 'platform_subdomain', 'active', 1, '{}', ?, ?, ?, 'active', 0, 1)", ["dom_a", "shp_a", "seller.selinow.com", now, now, now]],
    ["INSERT INTO shop_onboarding_profiles (shop_id, website_enabled, telegram_enabled, custom_domain_preference, current_step, version, created_at, updated_at) VALUES (?, 1, 0, 'later', 'readiness_passed', 1, ?, ?)", ["shp_a", now, now]],
    ["INSERT INTO products (id, shop_id, category_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, '', 'active', 'manual', 1, ?, ?)", ["prd_a", "shp_a", "license", "License", now, now]],
    ["INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, compare_at_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '{}', 10000, NULL, 'VND', 1, 10, 'active', 1, ?, ?)", ["var_a", "shp_a", "prd_a", "LICENSE", "License", now, now]],
    ["INSERT INTO payment_integrations (id, public_id, webhook_public_id, shop_id, provider, status, webhook_status, last_checked_at, last_webhook_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'payos', 'active', 'verified', ?, ?, ?, ?)", ["pay_a", "pay_public_a", "pay_webhook_a", "shp_a", now, now, now, now]],
  ];
  for (const [sql, values] of statements) database.prepare(sql).run(...values);
  for (const stepCode of [
    "account_ready", "shop_created", "channel_selected", "catalog_ready", "inventory_ready",
    "telegram_ready", "payos_ready", "domain_ready", "readiness_passed", "published",
  ]) {
    database.prepare("INSERT INTO shop_onboarding_steps (shop_id, step_code, status, version, created_at, updated_at) VALUES ('shp_a', ?, 'pending', 1, ?, ?)").run(stepCode, now, now);
  }
}

function envFor(database: SqliteD1): AppBindings {
  return {
    PLATFORM_BASE_DOMAIN: "selinow.com",
    PLATFORM_DB: database as unknown as D1Database,
  } as unknown as AppBindings;
}

describe("onboarding SQL transitions", () => {
  it("publishes a ready tenant and persists tenant-scoped evidence atomically", async () => {
    const database = createDatabase();
    seedReadyShop(database.database);
    const result = await publishReadyStorefront({
      env: envFor(database),
      expectedStorefrontVersion: 1,
      requestId: "request-sqlite-publish",
      shopPublicId: "shop_public_a",
      userId: "usr_a",
    });

    expect(result.ready).toBe(true);
    expect(database.database.prepare("SELECT status FROM shops WHERE id = 'shp_a'").get()).toEqual({ status: "active" });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM shop_readiness_runs WHERE shop_id = 'shp_a'").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT current_step AS currentStep FROM shop_onboarding_profiles WHERE shop_id = 'shp_a'").get()).toEqual({ currentStep: "published" });
    expect(database.database.prepare("SELECT status FROM shop_onboarding_steps WHERE shop_id = 'shp_a' AND step_code = 'published'").get()).toEqual({ status: "complete" });
    expect(database.database.prepare("SELECT published_branding_json AS branding, published_storefront_json AS storefront, published_version AS version FROM shop_settings WHERE shop_id = 'shp_a'").get()).toEqual({
      branding: '{"primaryColor":"#176B5B"}',
      storefront: '{"headline":"Draft storefront"}',
      version: 1,
    });
  });

  it("does not disclose another tenant onboarding snapshot", async () => {
    const database = createDatabase();
    seedReadyShop(database.database);
    await expect(getOnboardingState({
      env: envFor(database),
      shopPublicId: "shop_public_a",
      userId: "usr_b",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });
});
