import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { getShopReadiness } from "../../src/lib/tenants/readiness";
import {
  createShop,
  getShopCreationAdmission,
  getShopForMember,
  listShopsForMember,
  updateShopProfile,
} from "../../src/lib/tenants/store";

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
    IDENTIFIER_HMAC_SECRET: "shop-country-admission-secret",
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
      requesterAddress: `203.0.113.${input.userId === "user-a" ? "10" : "11"}`,
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
      requesterAddress: "203.0.113.10",
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
      requesterAddress: "203.0.113.10",
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
      requesterAddress: "203.0.113.10",
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
      requesterAddress: "203.0.113.10",
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
      requesterAddress: "203.0.113.10",
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
      requesterAddress: "203.0.113.10",
      requestId: "request-replay-mismatch",
      slug: "replay-changed",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("does not consume the shop-create requester budget for deterministic validation failures", async () => {
    const limitedEnv = {
      ...env,
      SHOP_CREATE_REQUESTER_RATE_LIMIT: "1",
    } as unknown as AppBindings;
    await expect(createShop({
      env: limitedEnv,
      idempotencyKey: "shop-invalid-admission-budget",
      name: "Reserved Shop",
      planCode: "starter",
      requesterAddress: "198.51.100.90",
      requestId: "request-invalid-admission-budget",
      slug: "admin",
      userId: "user-b",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["slug_reserved"], status: 409 });

    await expect(createShop({
      env: limitedEnv,
      idempotencyKey: "shop-valid-after-invalid-budget",
      name: "Valid Shop",
      planCode: "starter",
      requesterAddress: "198.51.100.90",
      requestId: "request-valid-after-invalid-budget",
      slug: "valid-after-invalid-budget",
      userId: "user-b",
    })).resolves.toMatchObject({ created: true });
  });

  it("returns one durable shop and consumes one admission for concurrent same-key creates", async () => {
    const limitedEnv = {
      ...env,
      SHOP_CREATE_SUBJECT_RATE_LIMIT: "1",
    } as unknown as AppBindings;
    const input = {
      env: limitedEnv,
      idempotencyKey: "shop-concurrent-replay",
      name: "Concurrent Replay",
      planCode: "starter",
      requesterAddress: "203.0.113.10",
      slug: "concurrent-replay",
      userId: "user-a",
    } as const;
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => createShop({
      ...input,
      requestId: `request-concurrent-${String(index)}`,
    })));
    expect(new Set(results.map((result) => result.shop.publicId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM shops WHERE slug = 'concurrent-replay'").get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM auth_request_admissions WHERE action = 'shop_create'
    `).get()).toEqual({ count: 1 });
  });

  it("serializes concurrent first-shop creates into one trial and one payment-pending shop", async () => {
    const attempts = await Promise.allSettled([
      createOwnedShop({ idempotencyKey: "shop-trial-race-a", slug: "trial-race-a", userId: "user-a" }),
      createOwnedShop({ idempotencyKey: "shop-trial-race-b", slug: "trial-race-b", userId: "user-a" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(2);
    expect(attempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value.shop.subscriptionState] : []).sort())
      .toEqual(["pending_payment", "trialing"]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_trial_claims WHERE user_id = 'user-a'").get()).toEqual({ count: 1 });
  });

  it("allows only one concurrent payment-pending shop per account", async () => {
    await createOwnedShop({ idempotencyKey: "shop-paid-race-trial", slug: "paid-race-trial", userId: "user-a" });

    const attempts = await Promise.allSettled([
      createOwnedShop({ idempotencyKey: "shop-paid-race-a", slug: "paid-race-a", userId: "user-a" }),
      createOwnedShop({ idempotencyKey: "shop-paid-race-b", slug: "paid-race-b", userId: "user-a" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "validation_failed", issues: ["billing_recovery_required"], status: 409 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM shop_subscriptions WHERE state = 'pending_payment'
    `).get()).toEqual({ count: 1 });
  });

  it("creates every additional shop as payment-pending without issuing another trial", async () => {
    await createOwnedShop({ idempotencyKey: "shop-trial-once", slug: "trial-once", userId: "user-a" });
    await expect(getShopCreationAdmission({ env, userId: "user-a" })).resolves.toEqual({
      allowed: true,
      creationMode: "paid",
      reason: "eligible",
      recoveryShopPublicId: null,
    });

    const paid = await createOwnedShop({ idempotencyKey: "shop-paid-second", slug: "paid-second", userId: "user-a" });
    expect(paid.shop.subscriptionState).toBe("pending_payment");
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM account_trial_claims WHERE user_id = 'user-a'
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT state, trial_ends_at AS trialEndsAt
      FROM shop_subscriptions
      WHERE shop_id = (SELECT id FROM shops WHERE public_id = ?)
    `).get(paid.shop.publicId)).toEqual({ state: "pending_payment", trialEndsAt: null });
    await expect(getShopCreationAdmission({ env, userId: "user-a" })).resolves.toEqual({
      allowed: false,
      creationMode: null,
      reason: "billing_recovery",
      recoveryShopPublicId: paid.shop.publicId,
    });
    await expect(createOwnedShop({ idempotencyKey: "shop-paid-third", slug: "paid-third", userId: "user-a" }))
      .rejects.toMatchObject({ code: "validation_failed", issues: ["billing_recovery_required"], status: 409 });
  });

  it("allows an invited viewer without a trial claim to create an independent shop", async () => {
    const ownerShop = await createOwnedShop({ idempotencyKey: "shop-invited-owner", slug: "invited-owner", userId: "user-a" });
    const shopId = (database.prepare("SELECT id FROM shops WHERE public_id = ?").get(ownerShop.shop.publicId) as { id: string }).id;
    database.prepare(`
      INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
      VALUES (?, 'user-b', 'viewer', 'active', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z')
    `).run(shopId);

    expect(await listShopsForMember({ env, userId: "user-b" })).toHaveLength(1);
    await expect(getShopCreationAdmission({ env, userId: "user-b" })).resolves.toEqual({
      allowed: true,
      creationMode: "trial",
      reason: "eligible",
      recoveryShopPublicId: null,
    });
  });

  it("routes a canceled owner to billing recovery without exposing the shop to ordinary navigation", async () => {
    const created = await createOwnedShop({ idempotencyKey: "shop-canceled-recovery", slug: "canceled-recovery", userId: "user-a" });
    database.prepare(`
      UPDATE shop_subscriptions
      SET state = 'canceled', canceled_at = '2026-08-01T00:00:00.000Z'
      WHERE shop_id = (SELECT id FROM shops WHERE public_id = ?)
    `).run(created.shop.publicId);

    await expect(listShopsForMember({ env, userId: "user-a" })).resolves.toEqual([]);
    await expect(getShopForMember({
      capability: "shop:read",
      env,
      shopPublicId: created.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(getShopForMember({
      capability: "billing:manage",
      env,
      shopPublicId: created.shop.publicId,
      userId: "user-a",
    })).resolves.toMatchObject({ shop: { publicId: created.shop.publicId, subscriptionState: "canceled" } });
    await expect(getShopCreationAdmission({ env, userId: "user-a" })).resolves.toEqual({
      allowed: false,
      creationMode: null,
      reason: "billing_recovery",
      recoveryShopPublicId: created.shop.publicId,
    });
  });

  it("allows paid provisioning without exposing the prior shop when the trial claimant is no longer an active owner", async () => {
    const created = await createOwnedShop({ idempotencyKey: "shop-private-recovery", slug: "private-recovery", userId: "user-a" });
    database.prepare(`
      UPDATE shop_subscriptions
      SET state = 'canceled', canceled_at = '2026-08-01T00:00:00.000Z'
      WHERE shop_id = (SELECT id FROM shops WHERE public_id = ?)
    `).run(created.shop.publicId);
    database.prepare(`
      UPDATE shop_members SET role = 'viewer'
      WHERE user_id = 'user-a' AND shop_id = (SELECT id FROM shops WHERE public_id = ?)
    `).run(created.shop.publicId);

    await expect(getShopCreationAdmission({ env, userId: "user-a" })).resolves.toEqual({
      allowed: true,
      creationMode: "paid",
      reason: "eligible",
      recoveryShopPublicId: null,
    });
  });

  it("allows recovery reads but denies mutations for expired and suspended subscriptions", async () => {
    const created = await createOwnedShop({ idempotencyKey: "shop-action-aware", slug: "action-aware", userId: "user-a" });
    database.prepare(`
      UPDATE shop_subscriptions SET trial_ends_at = '2099-01-01T00:00:00.000Z'
      WHERE shop_id = (SELECT id FROM shops WHERE public_id = ?)
    `).run(created.shop.publicId);

    await expect(getShopForMember({
      capability: "shop:read",
      env,
      now: new Date("2100-01-01T00:00:00.000Z"),
      shopPublicId: created.shop.publicId,
      subscriptionAction: "read",
      userId: "user-a",
    })).resolves.toMatchObject({ shop: { publicId: created.shop.publicId } });
    await expect(getShopForMember({
      capability: "shop:update",
      env,
      now: new Date("2100-01-01T00:00:00.000Z"),
      shopPublicId: created.shop.publicId,
      subscriptionAction: "mutation",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "subscription_payment_required", status: 402 });

    database.prepare(`
      UPDATE shop_subscriptions SET state = 'suspended'
      WHERE shop_id = (SELECT id FROM shops WHERE public_id = ?)
    `).run(created.shop.publicId);
    await expect(getShopForMember({
      capability: "billing:manage",
      env,
      shopPublicId: created.shop.publicId,
      userId: "user-a",
    })).resolves.toMatchObject({ shop: { subscriptionState: "suspended" } });
    await expect(getShopForMember({
      capability: "shop:update",
      env,
      shopPublicId: created.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "subscription_payment_required", status: 402 });
  });

  it.each(["active", "cancel_scheduled", "upgrade_pending", "downgrade_scheduled"])(
    "denies mutations after the authoritative paid period for %s",
    async (subscriptionState) => {
      const created = await createOwnedShop({
        idempotencyKey: `shop-expired-paid-${subscriptionState}`,
        slug: `expired-paid-${subscriptionState.replaceAll("_", "-")}`,
        userId: "user-a",
      });
      database.prepare(`
        UPDATE shop_subscriptions
        SET state = ?, trial_ends_at = NULL,
          current_period_start = '2026-07-01T00:00:00.000Z',
          current_period_end = '2026-08-01T00:00:00.000Z'
        WHERE shop_id = (SELECT id FROM shops WHERE public_id = ?)
      `).run(subscriptionState, created.shop.publicId);

      await expect(getShopForMember({
        capability: "shop:read",
        env,
        now: new Date("2026-08-02T00:00:00.000Z"),
        shopPublicId: created.shop.publicId,
        userId: "user-a",
      })).resolves.toMatchObject({ shop: { subscriptionState } });
      await expect(getShopForMember({
        capability: "shop:update",
        env,
        now: new Date("2026-08-02T00:00:00.000Z"),
        shopPublicId: created.shop.publicId,
        userId: "user-a",
      })).rejects.toMatchObject({ code: "subscription_payment_required", status: 402 });
    },
  );

  it("keeps globally duplicate slugs opaque across accounts", async () => {
    await createOwnedShop({ idempotencyKey: "shop-shared-slug-a", slug: "shared-slug", userId: "user-a" });
    const admissionCount = database.prepare(`
      SELECT COUNT(*) AS count FROM auth_request_admissions WHERE action = 'shop_create'
    `).get();
    await expect(createOwnedShop({ idempotencyKey: "shop-shared-slug-b", slug: "shared-slug", userId: "user-b" }))
      .rejects.toMatchObject({ code: "validation_failed", issues: ["slug_unavailable"], status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_trial_claims WHERE user_id = 'user-b'").get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM auth_request_admissions WHERE action = 'shop_create'
    `).get()).toEqual(admissionCount);
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

  it("persists country-only changes while legal and publish readiness remain fail-closed", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "shop-country-only", slug: "country-only", userId: "user-a" });
    const updated = await updateShopProfile({
      businessCountry: "US",
      env,
      merchantCountry: "VN",
      requestId: "request-country-only",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    });
    expect(updated).toMatchObject({ businessCountry: "US", merchantCountry: "VN" });
    expect(database.prepare(`
      SELECT support_contact AS supportContact, terms_url AS termsUrl,
        privacy_url AS privacyUrl, refund_policy_url AS refundPolicyUrl,
        policy_attestation_version AS attestationVersion
      FROM shop_settings
      WHERE shop_id = (SELECT id FROM shops WHERE public_id = ?)
    `).get(shop.shop.publicId)).toEqual({
      attestationVersion: null,
      privacyUrl: null,
      refundPolicyUrl: null,
      supportContact: null,
      termsUrl: null,
    });
    const readiness = await getShopReadiness({ env, shopPublicId: shop.shop.publicId, userId: "user-a" });
    expect(readiness.ready).toBe(false);
    expect(readiness.checks.find((check) => check.code === "policies_ready")).toMatchObject({ required: true, status: "fail" });
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
      requesterAddress: "203.0.113.11",
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
      requesterAddress: "203.0.113.10",
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
