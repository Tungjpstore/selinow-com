import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { createShop, getShopForMember, updateShopProfile } from "../../src/lib/tenants/store";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function createD1(database: DatabaseSync): D1Database {
  return {
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function applyMigrations(database: DatabaseSync, maximumVersion = Number.POSITIVE_INFINITY): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumVersion)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
}

function createEnv(database: DatabaseSync): AppBindings {
  return {
    DEFAULT_CURRENCY: "VND",
    DEFAULT_LOCALE: "vi",
    DEFAULT_TIMEZONE: "Asia/Ho_Chi_Minh",
    PLATFORM_BASE_DOMAIN: "staging.selinow.test",
    PLATFORM_DB: createD1(database),
    SESSION_SECRET: "test-session-secret-for-shop-country-service",
  } as unknown as AppBindings;
}

function insertUser(database: DatabaseSync, id: string, email: string): void {
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(id, email, id, now, now);
}

describe("shop country configuration service", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    insertUser(database, "user-a", "a@example.test");
    insertUser(database, "user-b", "b@example.test");
    env = createEnv(database);
  });

  afterEach(() => {
    database.close();
  });

  async function createOwnedShop(input: { idempotencyKey: string; slug: string; userId: string }) {
    return createShop({
      env,
      idempotencyKey: input.idempotencyKey,
      name: `Shop ${input.slug}`,
      planCode: "starter",
      requestId: `request-${input.slug}`,
      slug: input.slug,
      userId: input.userId,
    });
  }

  it("allows only public assignable paid plans for new shops", async () => {
    const defaultPlan = await createShop({
      env,
      idempotencyKey: "shop-default-paid-plan",
      name: "Default Paid Plan",
      requestId: "request-default-paid-plan",
      slug: "default-paid-plan",
      userId: "user-a",
    });
    expect(defaultPlan.shop.planCode).toBe("starter");

    await expect(createShop({
      env,
      idempotencyKey: "shop-legacy-plan-reject",
      name: "Legacy Plan",
      planCode: "store",
      requestId: "request-legacy-plan-reject",
      slug: "legacy-plan-reject",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["plan_invalid"], status: 400 });

    database.prepare("UPDATE plans SET is_assignable = 0 WHERE code = 'starter'").run();
    await expect(createShop({
      env,
      idempotencyKey: "shop-nonassignable-plan-reject",
      name: "Nonassignable Plan",
      planCode: "starter",
      requestId: "request-nonassignable-plan-reject",
      slug: "nonassignable-plan-reject",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["plan_invalid"], status: 400 });
  });

  it("normalizes explicit ISO countries at creation and replays the same durable projection", async () => {
    const first = await createShop({
      businessCountry: " us ",
      currency: " usd ",
      env,
      idempotencyKey: "shop-country-create-a",
      merchantCountry: "jp",
      name: "Global Shop",
      planCode: "starter",
      requestId: "request-create-a",
      slug: "global-shop",
      userId: "user-a",
    });
    const shopId = (database.prepare("SELECT id FROM shops WHERE public_id = ?").get(first.shop.publicId) as { id: string }).id;
    database.prepare("DELETE FROM activation_milestones WHERE shop_id = ?").run(shopId);
    const replay = await createShop({
      businessCountry: "US",
      currency: "USD",
      env,
      idempotencyKey: "shop-country-create-a",
      merchantCountry: "JP",
      name: "Global Shop",
      planCode: "starter",
      requestId: "request-create-a-replay",
      slug: "global-shop",
      userId: "user-a",
    });

    expect(first.created).toBe(true);
    expect(first.shop).toMatchObject({ businessCountry: "US", currency: "USD", defaultLocale: "vi-VN", merchantCountry: "JP" });
    expect(replay).toEqual({ created: false, shop: first.shop });
    expect(database.prepare("SELECT COUNT(*) AS count FROM activation_milestones WHERE shop_id = ?").get(shopId)).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT business_country_code AS businessCountry, currency, merchant_country_code AS merchantCountry
      FROM shops WHERE public_id = ?
    `).get(first.shop.publicId)).toEqual({ businessCountry: "US", currency: "USD", merchantCountry: "JP" });
  });

  it("creates the tenant bootstrap graph and bounded trial atomically", async () => {
    const created = await createOwnedShop({ idempotencyKey: "shop-atomic-bootstrap", slug: "atomic-bootstrap", userId: "user-a" });
    const shopId = (database.prepare("SELECT id FROM shops WHERE public_id = ?").get(created.shop.publicId) as { id: string }).id;
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM shop_members WHERE shop_id = ?) AS members,
        (SELECT COUNT(*) FROM shop_settings WHERE shop_id = ?) AS settings,
        (SELECT COUNT(*) FROM shop_onboarding_profiles WHERE shop_id = ?) AS profiles,
        (SELECT COUNT(*) FROM shop_onboarding_steps WHERE shop_id = ?) AS steps,
        (SELECT COUNT(*) FROM shop_subscriptions WHERE shop_id = ?) AS subscriptions,
        (SELECT COUNT(*) FROM account_trial_claims WHERE shop_id = ? AND user_id = 'user-a') AS claims
    `).get(shopId, shopId, shopId, shopId, shopId, shopId)).toEqual({
      claims: 1,
      members: 1,
      profiles: 1,
      settings: 1,
      steps: 10,
      subscriptions: 1,
    });
    const subscription = database.prepare(`
      SELECT state, trial_ends_at AS trialEndsAt
      FROM shop_subscriptions WHERE shop_id = ?
    `).get(shopId) as { state: string; trialEndsAt: string };
    expect(subscription.state).toBe("trialing");
    expect(Date.parse(subscription.trialEndsAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(subscription.trialEndsAt) - Date.now()).toBeLessThanOrEqual(7 * 24 * 60 * 60_000);
  });

  it("rejects an idempotency key replay with a different request body", async () => {
    await createOwnedShop({ idempotencyKey: "shop-replay-mismatch", slug: "replay-original", userId: "user-a" });
    await expect(createShop({
      env,
      idempotencyKey: "shop-replay-mismatch",
      name: "Changed replay",
      planCode: "pro",
      requestId: "request-replay-mismatch",
      slug: "replay-changed",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("returns one durable shop for concurrent same-key creates", async () => {
    const input = {
      env,
      idempotencyKey: "shop-concurrent-replay",
      name: "Concurrent Replay",
      planCode: "starter",
      slug: "concurrent-replay",
      userId: "user-a",
    } as const;
    const results = await Promise.all([
      createShop({ ...input, requestId: "request-concurrent-a" }),
      createShop({ ...input, requestId: "request-concurrent-b" }),
    ]);
    expect(new Set(results.map((result) => result.shop.publicId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM shops WHERE slug = 'concurrent-replay'").get()).toEqual({ count: 1 });
  });

  it("allows only one account evaluation even across concurrent different shop bodies", async () => {
    const attempts = await Promise.allSettled([
      createOwnedShop({ idempotencyKey: "shop-trial-race-a", slug: "trial-race-a", userId: "user-a" }),
      createOwnedShop({ idempotencyKey: "shop-trial-race-b", slug: "trial-race-b", userId: "user-a" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "validation_failed", issues: ["trial_already_used"], status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_trial_claims WHERE user_id = 'user-a'").get()).toEqual({ count: 1 });
  });

  it("does not reissue a trial after the first shop expires or is canceled", async () => {
    const first = await createOwnedShop({ idempotencyKey: "shop-trial-once", slug: "trial-once", userId: "user-a" });
    database.prepare(`
      UPDATE shop_subscriptions
      SET state = 'canceled', trial_ends_at = '2026-01-01T00:00:00.000Z', canceled_at = '2026-01-01T00:00:00.000Z'
      WHERE shop_id = (SELECT id FROM shops WHERE public_id = ?)
    `).run(first.shop.publicId);
    await expect(createOwnedShop({ idempotencyKey: "shop-trial-twice", slug: "trial-twice", userId: "user-a" }))
      .rejects.toMatchObject({ code: "validation_failed", issues: ["trial_already_used"], status: 409 });
  });

  it("keeps globally duplicate slugs opaque across accounts", async () => {
    await createOwnedShop({ idempotencyKey: "shop-shared-slug-a", slug: "shared-slug", userId: "user-a" });
    await expect(createOwnedShop({ idempotencyKey: "shop-shared-slug-b", slug: "shared-slug", userId: "user-b" }))
      .rejects.toMatchObject({ code: "validation_failed", issues: ["slug_unavailable"], status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_trial_claims WHERE user_id = 'user-b'").get()).toEqual({ count: 0 });
  });

  it("rejects an already-expired trial placeholder at the database boundary", () => {
    const now = "2026-08-08T00:00:00.000Z";
    database.prepare(`
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
      VALUES ('expired-shop', 'expired-public', 'expired-shop', 'Expired', 'draft', 'en', 'USD', 'UTC', 1, ?, ?)
    `).run(now, now);
    expect(() => database.prepare(`
      INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at)
      VALUES ('expired-sub', 'expired-shop', 'plan_starter_v1', 'trialing', '2026-01-01T00:00:00.000Z', ?, ?)
    `).run(now, now)).toThrow(/trial_subscription_expired/u);
  });

  it("updates countries through a tenant-scoped mutation and permits an explicit unknown state", async () => {
    const shopA = await createOwnedShop({ idempotencyKey: "shop-country-owner-a", slug: "owner-a", userId: "user-a" });
    const shopB = await createOwnedShop({ idempotencyKey: "shop-country-owner-b", slug: "owner-b", userId: "user-b" });

    const configured = await updateShopProfile({
      businessCountry: "de",
      env,
      merchantCountry: "sg",
      requestId: "request-country-update",
      shopPublicId: shopA.shop.publicId,
      userId: "user-a",
    });
    expect(configured).toMatchObject({ businessCountry: "DE", merchantCountry: "SG" });

    const cleared = await updateShopProfile({
      businessCountry: null,
      env,
      requestId: "request-country-clear",
      shopPublicId: shopA.shop.publicId,
      userId: "user-a",
    });
    expect(cleared).toMatchObject({ businessCountry: null, merchantCountry: "SG" });
    await expect(updateShopProfile({
      businessCountry: "FR",
      env,
      requestId: "request-cross-tenant",
      shopPublicId: shopA.shop.publicId,
      userId: "user-b",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });

    const reloadedA = await getShopForMember({ capability: "shop:read", env, shopPublicId: shopA.shop.publicId, userId: "user-a" });
    const reloadedB = await getShopForMember({ capability: "shop:read", env, shopPublicId: shopB.shop.publicId, userId: "user-b" });
    expect(reloadedA.shop).toMatchObject({ businessCountry: null, merchantCountry: "SG" });
    expect(reloadedB.shop).toMatchObject({ businessCountry: null, merchantCountry: null });
    expect(database.prepare(`
      SELECT json_extract(safe_metadata_json, '$.changedFields') AS changedFields
      FROM audit_logs WHERE shop_id = (
        SELECT id FROM shops WHERE public_id = ?
      ) AND action = 'shop.updated' ORDER BY rowid DESC LIMIT 1
    `).get(shopA.shop.publicId)).toEqual({ changedFields: '["businessCountry"]' });
  });

  it("rejects non-ISO and user-assigned country codes before mutation", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "shop-country-validation", slug: "validation", userId: "user-a" });

    await expect(updateShopProfile({
      businessCountry: "ZZ",
      env,
      requestId: "request-invalid-business",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["business_country_invalid"], status: 400 });
    await expect(updateShopProfile({
      env,
      merchantCountry: "XK",
      requestId: "request-invalid-merchant",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["merchant_country_invalid"], status: 400 });
    expect(database.prepare(`
      SELECT business_country_code AS businessCountry, merchant_country_code AS merchantCountry
      FROM shops WHERE public_id = ?
    `).get(shop.shop.publicId)).toEqual({ businessCountry: null, merchantCountry: null });
  });

  it.each(["USD", "EUR", "JPY", "VND"])("accepts supported shop currency %s", async (currency) => {
    const shop = await createOwnedShop({ idempotencyKey: `shop-currency-${currency}`, slug: `currency-${currency.toLowerCase()}`, userId: "user-a" });
    const updated = await updateShopProfile({
      currency: currency.toLowerCase(),
      env,
      requestId: `request-currency-${currency}`,
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    });
    expect(updated.currency).toBe(currency);
    expect(database.prepare("SELECT currency FROM shops WHERE public_id = ?").get(shop.shop.publicId))
      .toEqual({ currency });
  });

  it("rejects unsupported explicit and environment-default currencies", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "shop-currency-reject", slug: "currency-reject", userId: "user-a" });
    await expect(updateShopProfile({
      currency: "CAD",
      env,
      requestId: "request-currency-reject",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_invalid"], status: 400 });
    await expect(updateShopProfile({
      defaultLocale: "fr-FR",
      env,
      requestId: "request-locale-reject",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["locale_invalid"], status: 400 });

    const invalidDefaultEnv = { ...env, DEFAULT_CURRENCY: "CAD" } as unknown as AppBindings;
    await expect(createShop({
      env: invalidDefaultEnv,
      idempotencyKey: "shop-invalid-default-currency",
      name: "Invalid Currency",
      planCode: "starter",
      requestId: "request-invalid-default-currency",
      slug: "invalid-default-currency",
      userId: "user-b",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_invalid"], status: 400 });
  });

  it("does not strand tenant variants when changing the shop currency", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "shop-currency-variant", slug: "currency-variant", userId: "user-a" });
    const now = "2026-07-29T00:00:00.000Z";
    database.prepare(`
      INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
      VALUES ('product-currency', (SELECT id FROM shops WHERE public_id = ?), 'license', 'License', '', 'draft', 'manual', 1, ?, ?)
    `).run(shop.shop.publicId, now, now);
    database.prepare(`
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor, currency,
        min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES ('variant-currency', (SELECT id FROM shops WHERE public_id = ?), 'product-currency', 'SKU', 'License', '{}', 100, 'VND', 1, 1, 'active', 1, ?, ?)
    `).run(shop.shop.publicId, now, now);

    await expect(updateShopProfile({
      currency: "USD",
      env,
      requestId: "request-currency-variant",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_mismatch"], status: 409 });
    expect(database.prepare("SELECT currency FROM shops WHERE public_id = ?").get(shop.shop.publicId))
      .toEqual({ currency: "VND" });
  });

  it("accepts the supported locale aliases and canonicalizes the stored shop default", async () => {
    const shop = await createShop({
      defaultLocale: "en-US",
      env,
      idempotencyKey: "shop-default-locale",
      name: "Locale Shop",
      planCode: "starter",
      requestId: "request-default-locale",
      slug: "locale-shop",
      userId: "user-a",
    });
    expect(shop.shop.defaultLocale).toBe("en");
    const updated = await updateShopProfile({
      defaultLocale: "vi",
      env,
      requestId: "request-default-locale-update",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    });
    expect(updated.defaultLocale).toBe("vi-VN");
    expect(database.prepare("SELECT default_locale AS defaultLocale FROM shops WHERE public_id = ?").get(shop.shop.publicId))
      .toEqual({ defaultLocale: "vi-VN" });
  });

  it("reads legacy pre-0031 membership projections with unknown countries", async () => {
    const legacyDatabase = new DatabaseSync(":memory:");
    try {
      applyMigrations(legacyDatabase, 30);
      insertUser(legacyDatabase, "legacy-user", "legacy@example.test");
      const now = "2026-07-29T00:00:00.000Z";
      legacyDatabase.prepare(`
        INSERT INTO shops (
          id, public_id, slug, name, status, default_locale, currency, timezone,
          readiness_version, created_at, updated_at
        ) VALUES ('legacy-shop', 'legacy-public', 'legacy', 'Legacy', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
      `).run(now, now);
      legacyDatabase.prepare(`
        INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
        VALUES ('legacy-shop', 'legacy-user', 'owner', 'active', ?, ?)
      `).run(now, now);
      legacyDatabase.prepare(`
        INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
        VALUES ('legacy-sub', 'legacy-shop', 'plan_store_v1', 'active', ?, ?)
      `).run(now, now);

      const legacy = await getShopForMember({
        capability: "shop:read",
        env: createEnv(legacyDatabase),
        shopPublicId: "legacy-public",
        userId: "legacy-user",
      });
      expect(legacy.shop).toMatchObject({ businessCountry: null, merchantCountry: null });
    } finally {
      legacyDatabase.close();
    }
  });
});
