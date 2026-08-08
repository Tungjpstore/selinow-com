import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createBillingCheckout, createBillingRecoveryCheckout, executeDodoSubscriptionChangeRequest, expireBillingCheckoutSessions, processDodoWebhook, processDueDodoSubscriptionChanges } from "../../src/lib/billing/service";
import { cancelDodoSubscription, changeDodoSubscription, createDodoCheckout, getDodoConfig, parseDodoEvent, retrieveDodoSubscription, resumeDodoSubscription, verifyDodoWebhookSignature } from "../../src/lib/billing/dodo";
import { sha256Json } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

const SECRET = "dodo-webhook-secret-for-tests";
const NOW = 1_759_507_200;
const NOW_ISO = "2026-08-03T00:00:00.000Z";
const MIGRATION_TIMESTAMP = "'2026-08-01T00:00:00.000Z'";
const NOW_ISO_SECONDS = Math.floor(new Date(NOW_ISO).getTime() / 1000);
const WEBHOOK_PUBLIC_ID = "ddowh_00000000-0000-4000-8000-000000000001";

function env(overrides: Record<string, unknown> = {}): AppBindings {
  return {
    APP_ENV: "local",
    DODO_PAYMENTS_API_KEY: "dodo-api-key-for-tests",
    DODO_PAYMENTS_WEBHOOK_KEY: SECRET,
    PLATFORM_DB: {},
    ...overrides,
  } as unknown as AppBindings;
}

class SqliteStatement {
  constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
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
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    const migration = readFileSync(join(process.cwd(), "migrations", filename), "utf8")
      .replaceAll("CURRENT_TIMESTAMP", MIGRATION_TIMESTAMP);
    database.exec(migration);
  }
}

function billingFixture(state: "trialing" | "active" = "trialing"): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('billing-user-a', 'billing-a@example.test', 'Billing A', 'active', '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, merchant_country_code, created_at, updated_at)
    VALUES ('billing-shop-a', 'shop_00000000-0000-4000-8000-0000000000a1', 'billing-a', 'Billing A',
      'active', 'en', 'USD', 'UTC', 1, 'US', '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('billing-shop-a', 'billing-user-a', 'owner', 'active', '${NOW_ISO}', '${NOW_ISO}');
    UPDATE plan_prices SET provider_price_ref = 'prod_test_pro' WHERE id = 'price_pro_global_v1';
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, trial_ends_at,
      current_period_start, current_period_end, billing_provider_code, provider_subscription_ref,
      market_code, price_currency, price_amount_minor, price_interval, price_version, price_id,
      created_at, updated_at)
    VALUES ('billing-sub-a', 'billing-shop-a', 'plan_pro_v1', '${state}',
      '2026-08-10T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
      'dodo', 'sub_dodo_test', 'global', 'USD', 1500, 'month', 1, 'price_pro_global_v1',
      '${NOW_ISO}', '${NOW_ISO}');
  `);
  const d1 = new SqliteD1(database);
  return {
    database,
    env: env({
      DEFAULT_CURRENCY: "USD",
      DEFAULT_LOCALE: "en",
      DEFAULT_TIMEZONE: "UTC",
      PLATFORM_BASE_DOMAIN: "selinow.test",
      PLATFORM_DB: d1 as unknown as D1Database,
      DODO_PAYMENTS_API_BASE_URL: "https://test.dodopayments.com",
      SESSION_SECRET: "session-secret-for-tests",
    }),
  };
}

function signature(body: string, webhookId: string, timestamp = NOW): string {
  const digest = createHmac("sha256", SECRET).update(`${webhookId}.${String(timestamp)}.${body}`).digest("base64");
  return `v1,${digest}`;
}

function insertCompletedCheckout(database: DatabaseSync, id = "bchk-complete", planId = "plan_pro_v1", priceId = "price_pro_global_v1"): void {
  database.prepare(`
    INSERT INTO billing_checkout_sessions (
      id, public_id, shop_id, subscription_id, plan_id, price_id, provider_code,
      provider_checkout_ref, status, idempotency_key_hash, request_hash, expires_at,
      completed_at, created_at, updated_at
    ) VALUES (?, ?, 'billing-shop-a', 'billing-sub-a', ?, ?,
      'dodo', 'cks_dodo_test', 'completed', 'checkout-hash', 'request-hash',
      '2026-08-03T01:00:00.000Z', ?, ?, ?)
  `).run(id, id, planId, priceId, NOW_ISO, NOW_ISO, NOW_ISO);
}

function insertSubscriptionChangeRequest(database: DatabaseSync, input: { action: "cancel" | "change_plan"; id: string; requestedPlanId: string | null; currentPlanId?: string }): void {
  database.prepare(`
    INSERT INTO subscription_change_requests (
      id, public_id, shop_id, subscription_id, current_plan_id, requested_plan_id,
      action, status, expected_subscription_version, reason_code, requested_by_user_id,
      idempotency_key_hash, request_hash, created_at, updated_at, version
    ) VALUES (?, ?, 'billing-shop-a', 'billing-sub-a', ?, ?, ?, 'requested', 1,
      'seller_requested', 'billing-user-a', ?, ?, ?, ?, 1)
  `).run(input.id, input.id, input.currentPlanId ?? "plan_pro_v1", input.requestedPlanId, input.action, `${input.id}-key`, `${input.id}-hash`, NOW_ISO, NOW_ISO);
}

describe("Dodo billing adapter", () => {
  it("fails closed when provider credentials are not configured", () => {
    expect(() => getDodoConfig(env({ DODO_PAYMENTS_WEBHOOK_KEY: undefined }))).toThrow(
      expect.objectContaining({ code: "billing_provider_unavailable", status: 503 }),
    );
  });

  it("verifies Standard Webhooks raw-body signatures and rejects stale or modified payloads", async () => {
    const body = JSON.stringify({ type: "payment.succeeded", timestamp: "2026-08-03T00:00:00Z" });
    const webhookId = "evt_test";
    await expect(verifyDodoWebhookSignature({ body, header: signature(body, webhookId), now: NOW, secret: SECRET, timestamp: String(NOW), webhookId })).resolves.toBe(true);
    await expect(verifyDodoWebhookSignature({ body: `${body} `, header: signature(body, webhookId), now: NOW, secret: SECRET, timestamp: String(NOW), webhookId })).resolves.toBe(false);
    await expect(verifyDodoWebhookSignature({ body, header: signature(body, webhookId, NOW - 301), now: NOW, secret: SECRET, timestamp: String(NOW - 301), webhookId })).resolves.toBe(false);
  });

  it("normalizes Dodo payment amounts and product references", () => {
    const event = parseDodoEvent({
      data: {
        currency: "USD",
        metadata: { checkoutSessionId: "bchk_test" },
        payment_id: "pay_test",
        product_id: "prod_starter",
        subscription_id: "sub_test",
        total_amount: 500,
      },
      timestamp: "2026-08-03T00:00:00Z",
      type: "payment.succeeded",
    }, "evt_test");
    expect(event.amountMinor).toBe(500);
    expect(event.currency).toBe("USD");
    expect(event.priceId).toBe("prod_starter");
    expect(event.providerTransactionId).toBe("pay_test");
    expect(event.providerSubscriptionId).toBe("sub_test");
  });

  it("creates a Dodo checkout with product metadata and a trusted hosted URL", async () => {
    const config = getDodoConfig(env({ DODO_PAYMENTS_API_BASE_URL: "https://test.dodopayments.com" }));
    const fetcher: typeof fetch = (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer dodo-api-key-for-tests");
      expect(headers.get("Idempotency-Key")).toBe("checkout-key");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ billing_currency: "USD", metadata: { checkoutSessionId: "bchk_test" }, product_cart: [{ product_id: "prod_starter", quantity: 1 }] });
      return Promise.resolve(new Response(JSON.stringify({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_test", session_id: "cks_test" }), { status: 200 }));
    };
    await expect(createDodoCheckout({ config, currency: "USD", customData: { checkoutSessionId: "bchk_test" }, fetcher, idempotencyKey: "checkout-key", priceId: "prod_starter" })).resolves.toEqual({ checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_test", providerCheckoutId: "cks_test", providerTransactionId: "cks_test" });
  });

  it("retrieves subscription price evidence when a webhook omits it", async () => {
    const config = getDodoConfig(env({ DODO_PAYMENTS_API_BASE_URL: "https://test.dodopayments.com" }));
    const fetcher: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://test.dodopayments.com/subscriptions/sub_dodo_test");
      expect(init?.method).toBe("GET");
      return Promise.resolve(new Response(JSON.stringify({ id: "sub_dodo_test", product_id: "prod_test_pro", status: "active" }), { status: 200 }));
    };
    await expect(retrieveDodoSubscription({ config, fetcher, providerSubscriptionId: "sub_dodo_test" })).resolves.toEqual({ priceId: "prod_test_pro", providerSubscriptionId: "sub_dodo_test", status: "active" });
  });

  it("uses the verified Dodo subscription mutation paths with stable idempotency", async () => {
    const config = getDodoConfig(env({ DODO_PAYMENTS_API_BASE_URL: "https://test.dodopayments.com" }));
    const calls: Array<{ body: Record<string, unknown>; method: string; url: string }> = [];
    const fetcher: typeof fetch = (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ body: JSON.parse(body) as Record<string, unknown>, method: init?.method ?? "GET", url });
      return Promise.resolve(new Response(JSON.stringify({ id: "op_dodo_1", subscription_id: "sub_dodo_test" }), { status: 200 }));
    };
    await expect(changeDodoSubscription({ config, effectiveAt: "next_billing_date", fetcher, idempotencyKey: "stable-key", onPaymentFailure: "prevent_change", priceId: "prod_starter", providerSubscriptionId: "sub_dodo_test" })).resolves.toEqual({ providerActionRef: "op_dodo_1" });
    await expect(cancelDodoSubscription({ config, fetcher, idempotencyKey: "stable-key-cancel", providerSubscriptionId: "sub_dodo_test" })).resolves.toEqual({ providerActionRef: "op_dodo_1" });
    await expect(resumeDodoSubscription({ config, fetcher, idempotencyKey: "stable-key-resume", providerSubscriptionId: "sub_dodo_test" })).resolves.toEqual({ providerActionRef: "op_dodo_1" });
    expect(calls).toEqual([
      { body: { effective_at: "next_billing_date", on_payment_failure: "prevent_change", product_id: "prod_starter" }, method: "POST", url: "https://test.dodopayments.com/subscriptions/sub_dodo_test/change-plan" },
      { body: { cancel_at_next_billing_date: true, cancellation_comment: "cancelled_by_customer", cancel_reason: "cancelled_by_customer" }, method: "PATCH", url: "https://test.dodopayments.com/subscriptions/sub_dodo_test" },
      { body: { cancel_at_next_billing_date: false }, method: "PATCH", url: "https://test.dodopayments.com/subscriptions/sub_dodo_test" },
    ]);
  });

  it("executes an upgrade immediately and remains exactly-once after a replay", async () => {
    const fixture = billingFixture("active");
    fixture.database.prepare(`
      UPDATE shop_subscriptions
      SET plan_id = 'plan_starter_v1', market_code = 'global', price_currency = 'USD',
        price_amount_minor = 500, price_interval = 'month', price_version = 1,
        price_id = 'price_starter_global_v1', billing_provider_code = 'dodo'
      WHERE id = 'billing-sub-a'
    `).run();
    insertSubscriptionChangeRequest(fixture.database, { action: "change_plan", id: "sreq-upgrade", requestedPlanId: "plan_pro_v1", currentPlanId: "plan_starter_v1" });
    let calls = 0;
    const fetcher: typeof fetch = (_input, init) => {
      calls += 1;
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toMatchObject({ effective_at: "immediately", product_id: "prod_test_pro" });
      return Promise.resolve(new Response(JSON.stringify({ id: "change-upgrade-1" }), { status: 200 }));
    };
    const first = await executeDodoSubscriptionChangeRequest({ env: fixture.env, fetcher, requestPublicId: "sreq-upgrade", reviewedByUserId: "billing-user-a", shopId: "billing-shop-a", now: new Date(NOW_ISO) });
    const replay = await executeDodoSubscriptionChangeRequest({ env: fixture.env, fetcher, requestPublicId: "sreq-upgrade", reviewedByUserId: "billing-user-a", shopId: "billing-shop-a", now: new Date(NOW_ISO) });
    expect(first).toMatchObject({ providerActionRef: "change-upgrade-1", status: "provider_pending" });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    fixture.database.close();
  });

  it("schedules a downgrade for the next billing date", async () => {
    const fixture = billingFixture("active");
    fixture.database.prepare("UPDATE shop_subscriptions SET market_code = 'global', price_currency = 'USD', price_amount_minor = 1500, price_interval = 'month', price_version = 1, price_id = 'price_pro_global_v1', billing_provider_code = 'dodo' WHERE id = 'billing-sub-a'").run();
    fixture.database.prepare("UPDATE plan_prices SET provider_price_ref = 'prod_test_starter' WHERE id = 'price_starter_global_v1'").run();
    insertSubscriptionChangeRequest(fixture.database, { action: "change_plan", id: "sreq-downgrade", requestedPlanId: "plan_starter_v1" });
    const fetcher: typeof fetch = (_input, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({ effective_at: "next_billing_date", product_id: "prod_test_starter" });
      return Promise.resolve(new Response(JSON.stringify({ id: "change-downgrade-1" }), { status: 200 }));
    };
    await expect(executeDodoSubscriptionChangeRequest({ env: fixture.env, fetcher, requestPublicId: "sreq-downgrade", reviewedByUserId: "billing-user-a", shopId: "billing-shop-a", now: new Date(NOW_ISO) })).resolves.toMatchObject({ providerActionRef: "change-downgrade-1", status: "provider_pending" });
    fixture.database.close();
  });

  it("executes requested subscription changes from the scheduled runtime", async () => {
    const fixture = billingFixture("active");
    insertSubscriptionChangeRequest(fixture.database, { action: "cancel", id: "sreq-scheduled", requestedPlanId: null });
    const metrics = await processDueDodoSubscriptionChanges({
      env: fixture.env,
      fetcher: () => Promise.resolve(new Response(JSON.stringify({ id: "cancel-scheduled-1" }), { status: 200 })),
      now: new Date("2026-08-03T00:02:00.000Z"),
    });
    expect(metrics).toEqual({ attempted: 1, candidates: 1, failed: 0, providerPending: 1 });
    expect(fixture.database.prepare("SELECT status, provider_action_ref AS providerActionRef FROM subscription_change_requests WHERE id = 'sreq-scheduled'").get()).toEqual({ providerActionRef: "cancel-scheduled-1", status: "provider_pending" });
    fixture.database.close();
  });

  it("retries a timed-out provider operation with the same idempotency key", async () => {
    const fixture = billingFixture("active");
    fixture.database.prepare("UPDATE shop_subscriptions SET market_code = 'global', price_currency = 'USD', price_amount_minor = 1500, price_interval = 'month', price_version = 1, price_id = 'price_pro_global_v1', billing_provider_code = 'dodo' WHERE id = 'billing-sub-a'").run();
    insertSubscriptionChangeRequest(fixture.database, { action: "cancel", id: "sreq-cancel", requestedPlanId: null });
    const keys: string[] = [];
    let attempts = 0;
    const failing: typeof fetch = (_input, init) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      attempts += 1;
      return Promise.reject(new Error("timeout"));
    };
    await expect(executeDodoSubscriptionChangeRequest({ env: fixture.env, fetcher: failing, requestPublicId: "sreq-cancel", reviewedByUserId: "billing-user-a", shopId: "billing-shop-a", now: new Date(NOW_ISO) })).rejects.toMatchObject({ code: "billing_provider_unavailable" });
    const successful: typeof fetch = (_input, init) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return Promise.resolve(new Response(JSON.stringify({ id: "cancel-op-1" }), { status: 200 }));
    };
    await expect(executeDodoSubscriptionChangeRequest({ env: fixture.env, fetcher: successful, requestPublicId: "sreq-cancel", reviewedByUserId: "billing-user-a", shopId: "billing-shop-a", now: new Date(NOW_ISO) })).resolves.toMatchObject({ providerActionRef: "cancel-op-1", status: "provider_pending" });
    expect(attempts).toBe(1);
    expect(keys[0]).toBe(keys[1]);
    fixture.database.close();
  });

  it("completes a plan change from signed webhook evidence and updates the price snapshot", async () => {
    const fixture = billingFixture("active");
    fixture.database.exec(`
      UPDATE plan_prices SET provider_price_ref = 'prod_test_starter' WHERE id = 'price_starter_global_v1';
      UPDATE shop_subscriptions
      SET plan_id = 'plan_starter_v1', price_id = 'price_starter_global_v1',
        price_amount_minor = 500, price_version = 1
      WHERE id = 'billing-sub-a';
    `);
    insertCompletedCheckout(fixture.database, "bchk-change-plan", "plan_starter_v1", "price_starter_global_v1");
    insertSubscriptionChangeRequest(fixture.database, { action: "change_plan", currentPlanId: "plan_starter_v1", id: "sreq-webhook-upgrade", requestedPlanId: "plan_pro_v1" });
    await executeDodoSubscriptionChangeRequest({
      env: fixture.env,
      fetcher: () => Promise.resolve(new Response(JSON.stringify({ id: "change-webhook-upgrade" }), { status: 200 })),
      now: new Date(NOW_ISO),
      requestPublicId: "sreq-webhook-upgrade",
      reviewedByUserId: "billing-user-a",
      shopId: "billing-shop-a",
    });
    const payload = {
      data: {
        metadata: { checkoutSessionId: "bchk-change-plan", shopId: "billing-shop-a", subscriptionId: "billing-sub-a" },
        status: "active",
        subscription_id: "sub_dodo_test",
      },
      timestamp: NOW_ISO,
      type: "subscription.updated",
    };
    const body = JSON.stringify(payload);
    await expect(processDodoWebhook({
      env: fixture.env,
      fetcher: () => Promise.resolve(new Response(JSON.stringify({ id: "sub_dodo_test", product_id: "prod_test_pro", status: "active" }), { status: 200 })),
      now: new Date(NOW_ISO),
      rawBody: body,
      signature: signature(body, "evt_change_plan", NOW_ISO_SECONDS),
      webhookId: "evt_change_plan",
      webhookTimestamp: String(NOW_ISO_SECONDS),
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    })).resolves.toMatchObject({ processed: true, state: "active" });
    expect(fixture.database.prepare("SELECT status FROM subscription_change_requests WHERE id = 'sreq-webhook-upgrade'").get()).toEqual({ status: "completed" });
    expect(fixture.database.prepare("SELECT plan_id AS planId, price_id AS priceId, price_amount_minor AS amountMinor FROM shop_subscriptions WHERE id = 'billing-sub-a'").get()).toEqual({ amountMinor: 1500, planId: "plan_pro_v1", priceId: "price_pro_global_v1" });
    fixture.database.close();
  });

  it("converts a legacy Business trial to the published Starter VN offer only after signed payment evidence", async () => {
    const fixture = billingFixture("trialing");
    fixture.database.exec(`
      INSERT INTO plans (
        id, code, name, feature_flags_json, limits_json, version, is_active,
        created_at, updated_at, is_public, is_assignable, schema_version
      ) VALUES (
        'plan_business_v1', 'business', 'Business', '{}', '{}', 1, 1,
        '${NOW_ISO}', '${NOW_ISO}', 0, 0, 1
      );
      UPDATE shops
      SET merchant_country_code = 'VN', currency = 'VND'
      WHERE id = 'billing-shop-a';
      UPDATE plan_prices
      SET provider_price_ref = 'prod_test_starter_vn'
      WHERE id = 'price_starter_vn_v1';
      UPDATE shop_subscriptions
      SET plan_id = 'plan_business_v1', billing_provider_code = NULL,
        provider_customer_ref = NULL, provider_subscription_ref = NULL,
        market_code = NULL, price_currency = NULL, price_amount_minor = NULL,
        price_interval = NULL, price_version = NULL, price_id = NULL
      WHERE id = 'billing-sub-a';
    `);
    let checkoutMetadata: Record<string, string> = {};
    const checkout = await createBillingCheckout({
      env: fixture.env,
      fetcher: (_input, init) => {
        const body = JSON.parse(init?.body as string) as {
          billing_currency?: string;
          metadata?: Record<string, string>;
          product_cart?: Array<{ product_id?: string }>;
        };
        expect(body.billing_currency).toBe("VND");
        expect(body.product_cart).toEqual([{ product_id: "prod_test_starter_vn", quantity: 1 }]);
        checkoutMetadata = body.metadata ?? {};
        return Promise.resolve(new Response(JSON.stringify({
          checkout_url: "https://test.checkout.dodopayments.com/session/cks_legacy_starter_vn",
          session_id: "cks_legacy_starter_vn",
        }), { status: 200 }));
      },
      idempotencyKey: "checkout-legacy-business-vn-1",
      planCode: "starter",
      requestId: "request-legacy-business-vn",
      shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1",
      userId: "billing-user-a",
      now: new Date(NOW_ISO),
    });
    expect(checkout).toMatchObject({
      amountMinor: 99_000,
      currency: "VND",
      planCode: "starter",
      providerTransactionId: "cks_legacy_starter_vn",
      subscriptionState: "pending_payment",
    });
    expect(fixture.database.prepare(`
      SELECT plans.code AS planCode, subscriptions.state,
        subscriptions.provider_subscription_ref AS providerSubscriptionRef
      FROM shop_subscriptions AS subscriptions
      INNER JOIN plans ON plans.id = subscriptions.plan_id
      WHERE subscriptions.id = 'billing-sub-a'
    `).get()).toEqual({ planCode: "business", providerSubscriptionRef: null, state: "pending_payment" });

    const payload = {
      data: {
        checkout_session_id: "cks_legacy_starter_vn",
        currency: "VND",
        metadata: checkoutMetadata,
        payment_id: "pay_legacy_starter_vn",
        product_id: "prod_test_starter_vn",
        subscription_id: "sub_legacy_starter_vn",
        total_amount: 99_000,
      },
      timestamp: NOW_ISO,
      type: "payment.succeeded",
    };
    const body = JSON.stringify(payload);
    await expect(processDodoWebhook({
      env: fixture.env,
      now: new Date(NOW_ISO),
      rawBody: body,
      signature: signature(body, "evt_legacy_starter_vn", NOW_ISO_SECONDS),
      webhookId: "evt_legacy_starter_vn",
      webhookTimestamp: String(NOW_ISO_SECONDS),
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    })).resolves.toMatchObject({ processed: true, state: "active" });
    expect(fixture.database.prepare(`
      SELECT plans.code AS planCode, subscriptions.state,
        subscriptions.provider_subscription_ref AS providerSubscriptionRef
      FROM shop_subscriptions AS subscriptions
      INNER JOIN plans ON plans.id = subscriptions.plan_id
      WHERE subscriptions.id = 'billing-sub-a'
    `).get()).toEqual({ planCode: "starter", providerSubscriptionRef: "sub_legacy_starter_vn", state: "active" });
    fixture.database.close();
  });

  it("selects the newest currently effective price revision", async () => {
    const fixture = billingFixture("trialing");
    fixture.database.prepare("UPDATE plan_prices SET effective_to = '2999-01-01T00:00:00.000Z' WHERE id = 'price_pro_global_v1'").run();
    fixture.database.prepare(`
      INSERT INTO plan_prices (
        id, plan_id, market_code, currency, amount_minor, interval, tax_behavior,
        provider_code, provider_price_ref, effective_from, version, is_active,
        created_at, updated_at
      ) VALUES ('price_pro_global_v2', 'plan_pro_v1', 'global', 'USD', 1999, 'month', 'inclusive',
        'dodo', 'prod_test_pro_v2', '2026-08-03T00:00:00.000Z', 2, 1, ?, ?)
    `).run(NOW_ISO, NOW_ISO);
    let selectedPrice = "";
    const result = await createBillingCheckout({
      env: fixture.env,
      fetcher: (_input, init) => {
        const body = JSON.parse(init?.body as string) as { product_cart?: Array<{ product_id?: string }> };
        selectedPrice = body.product_cart?.[0]?.product_id ?? "";
        return Promise.resolve(new Response(JSON.stringify({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_price", session_id: "cks_price" }), { status: 200 }));
      },
      idempotencyKey: "checkout-price-revision-1",
      planCode: "pro",
      requestId: "request-price-revision",
      shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1",
      userId: "billing-user-a",
      now: new Date(NOW_ISO),
    });
    expect(result.amountMinor).toBe(1999);
    expect(selectedPrice).toBe("prod_test_pro_v2");
    fixture.database.close();
  });

  it("accepts subscription failure events when Dodo omits optional price fields", async () => {
    const fixture = billingFixture("active");
    insertCompletedCheckout(fixture.database);
    const payload = {
      data: {
        metadata: { checkoutSessionId: "bchk-complete", shopId: "billing-shop-a", subscriptionId: "billing-sub-a" },
        status: "failed",
        subscription_id: "sub_dodo_test",
      },
      timestamp: NOW_ISO,
      type: "subscription.failed",
    };
    const body = JSON.stringify(payload);
    await expect(processDodoWebhook({
      env: fixture.env,
      now: new Date(NOW_ISO),
      rawBody: body,
      signature: signature(body, "evt_subscription_failed", NOW_ISO_SECONDS),
      webhookId: "evt_subscription_failed",
      webhookTimestamp: String(NOW_ISO_SECONDS),
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    })).resolves.toMatchObject({ processed: true, state: "suspended" });
    expect(fixture.database.prepare("SELECT state FROM shop_subscriptions WHERE id = 'billing-sub-a'").get()).toEqual({ state: "suspended" });
    fixture.database.close();
  });

  it("ignores a signed provider event that is older than the latest transition evidence", async () => {
    const fixture = billingFixture("active");
    insertCompletedCheckout(fixture.database);
    const latest = {
      data: {
        metadata: { checkoutSessionId: "bchk-complete", shopId: "billing-shop-a", subscriptionId: "billing-sub-a" },
        status: "active",
        subscription_id: "sub_dodo_test",
      },
      timestamp: "2026-08-03T00:00:10.000Z",
      type: "subscription.updated",
    };
    const latestBody = JSON.stringify(latest);
    await expect(processDodoWebhook({
      env: fixture.env,
      now: new Date(NOW_ISO),
      rawBody: latestBody,
      signature: signature(latestBody, "evt_latest", NOW_ISO_SECONDS),
      webhookId: "evt_latest",
      webhookTimestamp: String(NOW_ISO_SECONDS),
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    })).resolves.toMatchObject({ processed: true, state: "active" });

    const stale = {
      data: {
        metadata: { checkoutSessionId: "bchk-complete", shopId: "billing-shop-a", subscriptionId: "billing-sub-a" },
        status: "expired",
        subscription_id: "sub_dodo_test",
      },
      timestamp: "2026-08-03T00:00:05.000Z",
      type: "subscription.updated",
    };
    const staleBody = JSON.stringify(stale);
    await expect(processDodoWebhook({
      env: fixture.env,
      now: new Date(NOW_ISO),
      rawBody: staleBody,
      signature: signature(staleBody, "evt_stale", NOW_ISO_SECONDS),
      webhookId: "evt_stale",
      webhookTimestamp: String(NOW_ISO_SECONDS),
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    })).resolves.toMatchObject({ processed: false, state: "stale" });
    expect(fixture.database.prepare("SELECT state FROM shop_subscriptions WHERE id = 'billing-sub-a'").get()).toEqual({ state: "active" });
    fixture.database.close();
  });

  it("converges concurrent deliveries of one signed event on one durable result", async () => {
    const fixture = billingFixture("active");
    insertCompletedCheckout(fixture.database);
    const payload = {
      data: {
        currency: "USD",
        metadata: { checkoutSessionId: "bchk-complete", shopId: "billing-shop-a", subscriptionId: "billing-sub-a" },
        product_id: "prod_test_pro",
        status: "active",
        subscription_id: "sub_dodo_test",
      },
      timestamp: NOW_ISO,
      type: "subscription.updated",
    };
    const body = JSON.stringify(payload);
    const results = await Promise.all(Array.from({ length: 2 }, () => processDodoWebhook({
      env: fixture.env,
      now: new Date(NOW_ISO),
      rawBody: body,
      signature: signature(body, "evt_concurrent", NOW_ISO_SECONDS),
      webhookId: "evt_concurrent",
      webhookTimestamp: String(NOW_ISO_SECONDS),
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    })));
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.processed)).toHaveLength(1);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM billing_provider_events WHERE provider_event_id = 'evt_concurrent'").get()).toEqual({ count: 1 });
    fixture.database.close();
  });

  it("reprocesses a failed signed event and records its terminal status", async () => {
    const fixture = billingFixture("active");
    fixture.database.prepare(`
      INSERT INTO billing_checkout_sessions (
        id, public_id, shop_id, subscription_id, plan_id, price_id, provider_code,
        provider_checkout_ref, status, idempotency_key_hash, request_hash, expires_at,
        completed_at, created_at, updated_at
      ) VALUES ('bchk-complete', 'bchk-complete', 'billing-shop-a', 'billing-sub-a',
        'plan_pro_v1', 'price_pro_global_v1', 'dodo', 'cks_dodo_test', 'completed',
        'checkout-hash', 'request-hash', '2026-08-03T01:00:00.000Z', '${NOW_ISO}', '${NOW_ISO}', '${NOW_ISO}')
    `).run();
    const payload = {
      data: {
        currency: "USD",
        metadata: { checkoutSessionId: "bchk-complete", shopId: "billing-shop-a", subscriptionId: "billing-sub-a" },
        product_id: "prod_test_pro",
        status: "active",
        subscription_id: "sub_dodo_test",
      },
      timestamp: NOW_ISO,
      type: "subscription.updated",
    };
    const payloadHash = await sha256Json(payload);
    fixture.database.prepare(`
      INSERT INTO billing_provider_events (
        id, provider_code, provider_event_id, provider_object_ref, shop_id, event_type,
        payload_hash, status, occurred_at, created_at
      ) VALUES ('bevt-failed', 'dodo', 'evt_failed_retry', 'sub_dodo_test',
        'billing-shop-a', 'subscription.updated', ?, 'failed', ?, ?)
    `).run(payloadHash, NOW_ISO, NOW_ISO);
    const body = JSON.stringify(payload);
    await expect(processDodoWebhook({
      env: fixture.env,
      now: new Date(NOW_ISO),
      rawBody: body,
      signature: signature(body, "evt_failed_retry", Math.floor(new Date(NOW_ISO).getTime() / 1000)),
      webhookId: "evt_failed_retry",
      webhookTimestamp: String(Math.floor(new Date(NOW_ISO).getTime() / 1000)),
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    })).resolves.toMatchObject({ duplicate: false, processed: true, state: "active" });
    expect(fixture.database.prepare("SELECT status FROM billing_provider_events WHERE id = 'bevt-failed'").get()).toEqual({ status: "processed" });
    fixture.database.close();
  });

  it("rolls back a competing checkout without leaving pending state", async () => {
    const fixture = billingFixture("trialing");
    fixture.database.prepare(`
      INSERT INTO billing_checkout_sessions (
        id, public_id, shop_id, subscription_id, plan_id, price_id, provider_code,
        status, idempotency_key_hash, request_hash, expires_at, created_at, updated_at
      ) VALUES ('bchk-existing', 'bchk-existing', 'billing-shop-a', 'billing-sub-a',
        'plan_pro_v1', 'price_pro_global_v1', 'dodo', 'pending', 'existing-key-hash',
        'existing-request-hash', '2026-08-03T01:00:00.000Z', '${NOW_ISO}', '${NOW_ISO}')
    `).run();
    await expect(createBillingCheckout({
      env: fixture.env,
      fetcher: fetch,
      idempotencyKey: "checkout-competing-001",
      planCode: "pro",
      requestId: "request-checkout-competing",
      shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1",
      userId: "billing-user-a",
      now: new Date(NOW_ISO),
    })).rejects.toMatchObject({ code: "billing_subscription_version_conflict", status: 409 });
    expect(fixture.database.prepare("SELECT state, version FROM shop_subscriptions WHERE id = 'billing-sub-a'").get()).toEqual({ state: "trialing", version: 1 });
    fixture.database.close();
  });

  it("retrieves an open checkout on same-key replay without persisting the hosted URL", async () => {
    const fixture = billingFixture("trialing");
    const fetcher: typeof fetch = (_input, init) => {
      if (init?.method === "GET") return Promise.resolve(new Response(JSON.stringify({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_replayed", session_id: "cks_replayed" }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_replay", session_id: "cks_replay" }), { status: 200 }));
    };
    const first = await createBillingCheckout({ env: fixture.env, fetcher, idempotencyKey: "checkout-replay-0001", planCode: "pro", requestId: "request-replay-1", shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1", userId: "billing-user-a", now: new Date(NOW_ISO) });
    const second = await createBillingCheckout({ env: fixture.env, fetcher, idempotencyKey: "checkout-replay-0001", planCode: "pro", requestId: "request-replay-2", shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1", userId: "billing-user-a", now: new Date(NOW_ISO) });
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_replayed", sessionId: first.sessionId });
    const columns = fixture.database.prepare("PRAGMA table_info(billing_checkout_sessions)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "checkout_url")).toBe(false);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM billing_checkout_sessions WHERE shop_id = 'billing-shop-a'").get()).toEqual({ count: 1 });
    fixture.database.close();
  });

  it("retries a response-lost checkout with the same provider idempotency key", async () => {
    const fixture = billingFixture("trialing");
    const providerKeys: string[] = [];
    const lostResponse: typeof fetch = (_input, init) => {
      providerKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return Promise.reject(new Error("response lost"));
    };
    await expect(createBillingCheckout({ env: fixture.env, fetcher: lostResponse, idempotencyKey: "checkout-response-loss-1", planCode: "pro", requestId: "request-response-loss-1", shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1", userId: "billing-user-a", now: new Date(NOW_ISO) })).rejects.toMatchObject({ code: "billing_provider_unavailable" });
    expect(fixture.database.prepare("SELECT status FROM billing_checkout_sessions").get()).toEqual({ status: "pending" });
    const recovered = await createBillingCheckout({
      env: fixture.env,
      fetcher: (_input, init) => {
        providerKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        return Promise.resolve(new Response(JSON.stringify({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_response_loss", session_id: "cks_response_loss" }), { status: 200 }));
      },
      idempotencyKey: "checkout-response-loss-1",
      planCode: "pro",
      requestId: "request-response-loss-2",
      shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1",
      userId: "billing-user-a",
      now: new Date(NOW_ISO),
    });
    expect(recovered).toMatchObject({ duplicate: true, providerTransactionId: "cks_response_loss" });
    expect(providerKeys[0]).toBe(providerKeys[1]);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM billing_checkout_sessions").get()).toEqual({ count: 1 });
    fixture.database.close();
  });

  it("expires a stale conversion and permits suspended recovery only through a new checkout", async () => {
    const fixture = billingFixture("trialing");
    let postCount = 0;
    const fetcher: typeof fetch = (_input, init) => {
      if (init?.method === "GET") return Promise.resolve(new Response(JSON.stringify({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_recovery", session_id: "cks_recovery" }), { status: 200 }));
      postCount += 1;
      const suffix = postCount === 1 ? "expire" : "recovery";
      return Promise.resolve(new Response(JSON.stringify({ checkout_url: `https://test.checkout.dodopayments.com/session/cks_${suffix}`, session_id: `cks_${suffix}` }), { status: 200 }));
    };
    await createBillingCheckout({ env: fixture.env, fetcher, idempotencyKey: "checkout-expire-0001", planCode: "pro", requestId: "request-expire-1", shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1", userId: "billing-user-a", now: new Date(NOW_ISO) });
    expect(await expireBillingCheckoutSessions({ env: fixture.env, now: new Date("2026-08-03T00:31:00.000Z") })).toBe(1);
    expect(fixture.database.prepare("SELECT status FROM billing_checkout_sessions").get()).toEqual({ status: "expired" });
    expect(fixture.database.prepare("SELECT state FROM shop_subscriptions").get()).toEqual({ state: "suspended" });
    await expect(createBillingCheckout({ env: fixture.env, fetcher, idempotencyKey: "checkout-expire-0002", planCode: "pro", requestId: "request-expire-2", shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1", userId: "billing-user-a", now: new Date("2026-08-03T00:31:00.000Z") })).rejects.toMatchObject({ code: "subscription_payment_required" });
    const recovery = await createBillingRecoveryCheckout({ env: fixture.env, fetcher, idempotencyKey: "checkout-recover-0001", planCode: "pro", requestId: "request-recover-1", shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1", userId: "billing-user-a", now: new Date("2026-08-03T00:31:00.000Z") });
    expect(recovery).toMatchObject({ duplicate: false, subscriptionState: "pending_payment" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM billing_checkout_sessions WHERE status IN ('pending', 'open')").get()).toEqual({ count: 1 });
    fixture.database.close();
  });

  it("releases a failed initial checkout and exposes immediate suspended recovery", async () => {
    const fixture = billingFixture("trialing");
    let calls = 0;
    const fetcher: typeof fetch = () => {
      calls += 1;
      const suffix = calls === 1 ? "initial_failed" : "initial_recovery";
      return Promise.resolve(new Response(JSON.stringify({ checkout_url: `https://test.checkout.dodopayments.com/session/cks_${suffix}`, session_id: `cks_${suffix}` }), { status: 200 }));
    };
    const checkout = await createBillingCheckout({ env: fixture.env, fetcher, idempotencyKey: "checkout-initial-failure-1", planCode: "pro", requestId: "request-initial-failure", shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1", userId: "billing-user-a", now: new Date(NOW_ISO) });
    const payload = {
      data: {
        currency: "USD",
        metadata: { checkoutSessionId: checkout.sessionId, shopId: "billing-shop-a", subscriptionId: "billing-sub-a" },
        payment_id: "cks_initial_failed",
        product_id: "prod_test_pro",
        status: "failed",
        subscription_id: "sub_dodo_test",
      },
      timestamp: NOW_ISO,
      type: "payment.failed",
    };
    const body = JSON.stringify(payload);
    await expect(processDodoWebhook({
      env: fixture.env,
      now: new Date(NOW_ISO),
      rawBody: body,
      signature: signature(body, "evt_initial_failed", NOW_ISO_SECONDS),
      webhookId: "evt_initial_failed",
      webhookTimestamp: String(NOW_ISO_SECONDS),
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    })).resolves.toMatchObject({ processed: true, state: "suspended" });
    expect(fixture.database.prepare("SELECT status FROM billing_checkout_sessions WHERE id = ?").get(checkout.sessionId)).toEqual({ status: "failed" });
    const recovery = await createBillingRecoveryCheckout({ env: fixture.env, fetcher, idempotencyKey: "checkout-initial-recovery-1", planCode: "pro", requestId: "request-initial-recovery", shopPublicId: "shop_00000000-0000-4000-8000-0000000000a1", userId: "billing-user-a", now: new Date("2026-08-03T00:01:00.000Z") });
    expect(recovery).toMatchObject({ duplicate: false, providerTransactionId: "cks_initial_recovery" });
    fixture.database.close();
  });
});
