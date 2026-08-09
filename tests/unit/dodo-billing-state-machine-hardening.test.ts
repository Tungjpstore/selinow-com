import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { processDodoWebhook, suspendExpiredBillingGracePeriods } from "../../src/lib/billing/service";
import { parseDodoEvent } from "../../src/lib/billing/dodo";
import type { AppBindings } from "../../src/lib/platform/bindings";

const SECRET = "dodo-webhook-secret-for-state-tests";
const NOW_ISO = "2026-08-08T00:00:00.000Z";
const NOW_SECONDS = Math.floor(new Date(NOW_ISO).getTime() / 1000);
const WEBHOOK_PUBLIC_ID = "ddowh_00000000-0000-4000-8000-000000000081";

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
  beforeNextBatch: (() => void) | null = null;

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeBatch?.();
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
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8").replaceAll("CURRENT_TIMESTAMP", `'${NOW_ISO}'`));
  }
}

function fixture(input: { providerSubscriptionRef: string | null; state: "active" | "trialing" } = { providerSubscriptionRef: null, state: "trialing" }): { database: DatabaseSync; env: AppBindings; platformDb: SqliteD1 } {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('billing-user-hardening', 'billing-hardening@example.test', 'Billing Hardening', 'active', '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, merchant_country_code, created_at, updated_at)
    VALUES ('billing-shop-hardening', 'shop_00000000-0000-4000-8000-000000000081', 'billing-hardening', 'Billing Hardening',
      'active', 'en', 'USD', 'UTC', 1, 'US', '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('billing-shop-hardening', 'billing-user-hardening', 'owner', 'active', '${NOW_ISO}', '${NOW_ISO}');
    UPDATE plan_prices SET provider_price_ref = 'prod_test_pro' WHERE id = 'price_pro_global_v1';
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, trial_ends_at,
      current_period_start, current_period_end, billing_provider_code, provider_subscription_ref,
      market_code, price_currency, price_amount_minor, price_interval, price_version, price_id,
      created_at, updated_at)
    VALUES ('billing-sub-hardening', 'billing-shop-hardening', 'plan_pro_v1', '${input.state}',
      '2026-08-15T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
      'dodo', ${input.providerSubscriptionRef === null ? "NULL" : `'${input.providerSubscriptionRef}'`}, 'global', 'USD', 1500, 'month', 1, 'price_pro_global_v1',
      '${NOW_ISO}', '${NOW_ISO}');
  `);
  const platformDb = new SqliteD1(database);
  return {
    database,
    env: {
      APP_ENV: "local",
      DODO_PAYMENTS_API_KEY: "dodo-api-key-for-state-tests",
      DODO_PAYMENTS_API_BASE_URL: "https://test.dodopayments.com",
      DODO_PAYMENTS_WEBHOOK_KEY: SECRET,
      PLATFORM_DB: platformDb as unknown as D1Database,
      SESSION_SECRET: "session-secret-for-state-tests",
    } as unknown as AppBindings,
    platformDb,
  };
}

function addCheckout(database: DatabaseSync, input: { status: "completed" | "open"; id?: string; providerCheckoutRef?: string }): void {
  const id = input.id ?? "bchk-hardening";
  const providerCheckoutRef = input.providerCheckoutRef ?? "chk_test_hardening";
  database.prepare(`
    INSERT INTO billing_checkout_sessions (
      id, public_id, shop_id, subscription_id, plan_id, price_id, provider_code,
      provider_checkout_ref, status, idempotency_key_hash, request_hash, expires_at,
      completed_at, created_at, updated_at
    ) VALUES (?, ?, 'billing-shop-hardening', 'billing-sub-hardening',
      'plan_pro_v1', 'price_pro_global_v1', 'dodo', ?, ?, ?, ?,
      '2026-08-09T00:00:00.000Z', ?, ?, ?)
  `).run(id, id, providerCheckoutRef, input.status, `checkout-key-${id}`, `request-hash-${id}`, input.status === "completed" ? NOW_ISO : null, NOW_ISO, NOW_ISO);
}

function bodyFor(input: { eventType: string; metadata?: Record<string, string> | undefined; occurredAt?: string; status?: string; paymentId?: string; subscriptionId?: string; amount?: number; periodStart?: string; periodEnd?: string; checkoutSessionId?: string; productId?: string; scheduledPriceId?: string; cancelAtNextBillingDate?: boolean }): string {
  return JSON.stringify({
    data: {
      ...(input.checkoutSessionId === undefined ? { checkout_session_id: "chk_test_hardening" } : input.checkoutSessionId === "" ? {} : { checkout_session_id: input.checkoutSessionId }),
      currency: "USD",
      ...(input.amount === undefined ? {} : { total_amount: input.amount }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.paymentId === undefined ? {} : { payment_id: input.paymentId }),
      ...(input.periodEnd === undefined ? {} : { period_end: input.periodEnd }),
      ...(input.periodStart === undefined ? {} : { period_start: input.periodStart }),
      product_id: input.productId ?? "prod_test_pro",
      ...(input.scheduledPriceId === undefined ? {} : { scheduled_change: { product_id: input.scheduledPriceId } }),
      ...(input.cancelAtNextBillingDate === undefined ? {} : { cancel_at_next_billing_date: input.cancelAtNextBillingDate }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.subscriptionId === undefined ? {} : { subscription_id: input.subscriptionId }),
    },
    timestamp: input.occurredAt ?? NOW_ISO,
    type: input.eventType,
  });
}

function signed(body: string, webhookId: string): string {
  return `v1,${createHmac("sha256", SECRET).update(`${webhookId}.${String(NOW_SECONDS)}.${body}`).digest("base64")}`;
}

async function webhook(fixtureValue: ReturnType<typeof fixture>, body: string, webhookId: string, now = NOW_ISO): Promise<unknown> {
  return processDodoWebhook({
    env: fixtureValue.env,
    now: new Date(now),
    rawBody: body,
    signature: signed(body, webhookId),
    webhookId,
    webhookPublicId: WEBHOOK_PUBLIC_ID,
    webhookTimestamp: String(NOW_SECONDS),
  });
}

const exactMetadata = {
  amountMinor: "1500",
  checkoutSessionId: "bchk-hardening",
  currency: "USD",
  marketCode: "global",
  planCode: "pro",
  providerPriceRef: "prod_test_pro",
  shopId: "billing-shop-hardening",
  subscriptionId: "billing-sub-hardening",
};

describe("Dodo billing state-machine hardening", () => {
  it("activates an initial payment only with exact checkout, subscription and tenant metadata", async () => {
    const testFixture = fixture();
    addCheckout(testFixture.database, { status: "open" });
    const body = bodyFor({
      amount: 1500,
      eventType: "payment.succeeded",
      metadata: exactMetadata,
      paymentId: "pay_test_initial",
      subscriptionId: "sub_test_initial",
    });
    expect(parseDodoEvent(JSON.parse(body) as unknown, "msg_initial_exact")).toMatchObject({ providerCheckoutId: "chk_test_hardening", providerSubscriptionId: "sub_test_initial" });

    await expect(webhook(testFixture, body, "msg_initial_exact")).resolves.toMatchObject({ processed: true, state: "active" });
    expect(testFixture.database.prepare("SELECT state, provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "active", providerSubscriptionRef: "sub_test_initial" });
    testFixture.database.close();
  });

  it("acknowledges pre-payment subscription lifecycle events through the signed checkout identity", async () => {
    const testFixture = fixture();
    testFixture.database.prepare("UPDATE shop_subscriptions SET state = 'pending_payment' WHERE id = 'billing-sub-hardening'").run();
    addCheckout(testFixture.database, { status: "open" });
    const activeBody = bodyFor({
      checkoutSessionId: "",
      eventType: "subscription.active",
      metadata: exactMetadata,
      status: "active",
      subscriptionId: "sub_test_initial",
    });
    const updatedBody = bodyFor({
      checkoutSessionId: "",
      eventType: "subscription.updated",
      metadata: exactMetadata,
      status: "active",
      subscriptionId: "sub_test_initial",
      occurredAt: "2026-08-08T00:00:01.000Z",
    });

    await expect(webhook(testFixture, activeBody, "msg_subscription_active_before_payment")).resolves.toEqual({ duplicate: false, processed: false, state: "pending_payment" });
    await expect(webhook(testFixture, activeBody, "msg_subscription_active_before_payment")).resolves.toEqual({ duplicate: true, processed: false, state: "ignored" });
    await expect(webhook(testFixture, updatedBody, "msg_subscription_updated_before_payment")).resolves.toEqual({ duplicate: false, processed: false, state: "pending_payment" });
    expect(testFixture.database.prepare("SELECT state, provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "pending_payment", providerSubscriptionRef: null });
    expect(testFixture.database.prepare("SELECT event_type AS eventType, status FROM billing_provider_events WHERE shop_id = 'billing-shop-hardening' ORDER BY event_type").all()).toEqual([
      { eventType: "subscription.active", status: "ignored" },
      { eventType: "subscription.updated", status: "ignored" },
    ]);
    testFixture.database.close();
  });

  it("does not bind a failed pre-payment subscription event or block a fresh recovery checkout", async () => {
    const testFixture = fixture();
    testFixture.database.prepare("UPDATE shop_subscriptions SET state = 'pending_payment' WHERE id = 'billing-sub-hardening'").run();
    addCheckout(testFixture.database, { status: "open" });
    const failedBody = bodyFor({
      checkoutSessionId: "",
      eventType: "subscription.failed",
      metadata: exactMetadata,
      status: "failed",
      subscriptionId: "sub_test_failed_before_payment",
    });

    await expect(webhook(testFixture, failedBody, "msg_subscription_failed_before_payment")).resolves.toEqual({ duplicate: false, processed: true, state: "suspended" });
    expect(testFixture.database.prepare("SELECT state, provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "suspended", providerSubscriptionRef: null });
    expect(testFixture.database.prepare("SELECT status FROM billing_checkout_sessions WHERE id = 'bchk-hardening'").get()).toEqual({ status: "failed" });

    addCheckout(testFixture.database, { id: "bchk-hardening-recovery", providerCheckoutRef: "chk_test_recovery", status: "open" });
    const recoveryMetadata = { ...exactMetadata, checkoutSessionId: "bchk-hardening-recovery" };
    const recoveryBody = bodyFor({
      amount: 1500,
      checkoutSessionId: "chk_test_recovery",
      eventType: "payment.succeeded",
      metadata: recoveryMetadata,
      paymentId: "pay_test_recovery",
      subscriptionId: "sub_test_recovery",
      occurredAt: "2026-08-08T00:01:00.000Z",
    });
    await expect(webhook(testFixture, recoveryBody, "msg_payment_recovery")).resolves.toMatchObject({ duplicate: false, processed: true, state: "active" });
    expect(testFixture.database.prepare("SELECT state, provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "active", providerSubscriptionRef: "sub_test_recovery" });
    testFixture.database.close();
  });

  it("durably records a tenant-mismatched signed event and converges replay", async () => {
    const testFixture = fixture();
    addCheckout(testFixture.database, { status: "open" });
    const body = bodyFor({
      amount: 1500,
      eventType: "payment.succeeded",
      metadata: { ...exactMetadata, shopId: "billing-shop-other" },
      paymentId: "pay_test_wrong_shop",
      subscriptionId: "sub_test_wrong_shop",
    });

    await expect(webhook(testFixture, body, "msg_wrong_shop_durable")).rejects.toMatchObject({ code: "billing_webhook_identity_mismatch", status: 409 });
    expect(testFixture.database.prepare("SELECT shop_id AS shopId, subscription_id AS subscriptionId, status FROM billing_provider_events WHERE provider_code = 'dodo' AND provider_event_id = 'msg_wrong_shop_durable'").get()).toEqual({ shopId: null, subscriptionId: null, status: "conflict" });
    expect(testFixture.database.prepare("SELECT action, shop_id AS shopId FROM audit_logs WHERE request_id = 'dodo-webhook:msg_wrong_shop_durable'").get()).toEqual({ action: "billing.webhook_identity_mismatch", shopId: null });

    await expect(webhook(testFixture, body, "msg_wrong_shop_durable")).resolves.toEqual({ duplicate: true, processed: false, state: "conflict" });
    expect(testFixture.database.prepare("SELECT COUNT(*) AS count FROM billing_provider_events WHERE provider_code = 'dodo' AND provider_event_id = 'msg_wrong_shop_durable'").get()).toEqual({ count: 1 });
    expect(testFixture.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'dodo-webhook:msg_wrong_shop_durable'").get()).toEqual({ count: 1 });
    testFixture.database.close();
  });

  it("keeps a late signed payment fail-closed, then activates one fresh checkout exactly once", async () => {
    const testFixture = fixture();
    addCheckout(testFixture.database, { status: "open" });
    testFixture.database.prepare("UPDATE billing_checkout_sessions SET expires_at = ?, status = 'expired', expired_at = ?, updated_at = ?, version = version + 1 WHERE id = 'bchk-hardening'").run(NOW_ISO, NOW_ISO, NOW_ISO);
    testFixture.database.prepare("UPDATE shop_subscriptions SET state = 'suspended', updated_at = ?, version = version + 1 WHERE id = 'billing-sub-hardening'").run(NOW_ISO);
    const lateBody = bodyFor({
      amount: 1500,
      eventType: "payment.succeeded",
      metadata: exactMetadata,
      paymentId: "pay_test_late",
      subscriptionId: "sub_test_late",
    });
    await expect(webhook(testFixture, lateBody, "msg_payment_late")).rejects.toMatchObject({ code: "billing_webhook_checkout_expired", status: 409 });
    expect(testFixture.database.prepare("SELECT state, provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "suspended", providerSubscriptionRef: null });
    expect(testFixture.database.prepare("SELECT status FROM billing_provider_events WHERE provider_event_id = 'msg_payment_late'").get()).toEqual({ status: "conflict" });
    expect(testFixture.database.prepare("SELECT action, safe_metadata_json AS safeMetadataJson FROM audit_logs WHERE resource_id = (SELECT id FROM billing_provider_events WHERE provider_event_id = 'msg_payment_late')").get()).toEqual({
      action: "billing.webhook_rejected",
      safeMetadataJson: JSON.stringify({ eventType: "payment.succeeded", failureCode: "billing_webhook_checkout_expired" }),
    });
    const lateProjectionBody = bodyFor({
      checkoutSessionId: "",
      eventType: "subscription.updated",
      metadata: exactMetadata,
      occurredAt: "2026-08-08T00:00:01.000Z",
      status: "active",
      subscriptionId: "sub_test_late",
    });
    await expect(webhook(testFixture, lateProjectionBody, "msg_subscription_late_projection")).resolves.toEqual({ duplicate: false, processed: false, state: "suspended" });
    expect(testFixture.database.prepare("SELECT state, provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "suspended", providerSubscriptionRef: null });

    addCheckout(testFixture.database, { id: "bchk-hardening-fresh", providerCheckoutRef: "chk_test_fresh", status: "open" });
    const freshMetadata = { ...exactMetadata, checkoutSessionId: "bchk-hardening-fresh" };
    const freshBody = bodyFor({
      amount: 1500,
      checkoutSessionId: "chk_test_fresh",
      eventType: "payment.succeeded",
      metadata: freshMetadata,
      paymentId: "pay_test_fresh",
      subscriptionId: "sub_test_fresh",
    });
    await expect(webhook(testFixture, freshBody, "msg_payment_fresh")).resolves.toMatchObject({ duplicate: false, processed: true, state: "active" });
    await expect(webhook(testFixture, freshBody, "msg_payment_fresh")).resolves.toEqual({ duplicate: true, processed: false, state: "processed" });
    expect(testFixture.database.prepare("SELECT state, provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "active", providerSubscriptionRef: "sub_test_fresh" });
    expect(testFixture.database.prepare("SELECT COUNT(*) AS count FROM subscription_events WHERE subscription_id = 'billing-sub-hardening' AND event_type = 'payment.succeeded'").get()).toEqual({ count: 1 });
    testFixture.database.close();
  });

  it("rejects and audits a completed-checkout payment that tries to rebind the Dodo subscription", async () => {
    const testFixture = fixture({ providerSubscriptionRef: "sub_test_bound", state: "active" });
    addCheckout(testFixture.database, { status: "completed" });
    const before = testFixture.database.prepare(`
      SELECT state, provider_subscription_ref AS providerSubscriptionRef,
        current_period_start AS periodStart, current_period_end AS periodEnd, version
      FROM shop_subscriptions
      WHERE id = 'billing-sub-hardening'
    `).get();
    const body = bodyFor({
      amount: 1500,
      eventType: "payment.succeeded",
      metadata: exactMetadata,
      paymentId: "pay_test_rebind",
      subscriptionId: "sub_test_rebind",
    });

    await expect(webhook(testFixture, body, "msg_payment_rebind")).rejects.toMatchObject({ code: "billing_webhook_identity_mismatch", status: 409 });
    expect(testFixture.database.prepare(`
      SELECT state, provider_subscription_ref AS providerSubscriptionRef,
        current_period_start AS periodStart, current_period_end AS periodEnd, version
      FROM shop_subscriptions
      WHERE id = 'billing-sub-hardening'
    `).get()).toEqual(before);
    expect(testFixture.database.prepare(`
      SELECT status, shop_id AS shopId, subscription_id AS subscriptionId
      FROM billing_provider_events
      WHERE provider_code = 'dodo' AND provider_event_id = 'msg_payment_rebind'
    `).get()).toEqual({ shopId: "billing-shop-hardening", status: "conflict", subscriptionId: "billing-sub-hardening" });
    expect(testFixture.database.prepare(`
      SELECT action, resource_type AS resourceType, source_kind AS sourceKind,
        retention_class AS retentionClass, safe_metadata_json AS safeMetadataJson
      FROM audit_logs
      WHERE action = 'billing.webhook_identity_mismatch'
    `).get()).toEqual({
      action: "billing.webhook_identity_mismatch",
      resourceType: "billing_provider_event",
      retentionClass: "financial",
      safeMetadataJson: JSON.stringify({ eventType: "payment.succeeded", failureCode: "billing_webhook_identity_mismatch" }),
      sourceKind: "http",
    });
    await expect(webhook(testFixture, body, "msg_payment_rebind")).resolves.toEqual({ duplicate: true, processed: false, state: "conflict" });
    expect(testFixture.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'billing.webhook_identity_mismatch'").get()).toEqual({ count: 1 });
    testFixture.database.close();
  });

  it("binds a legacy null Dodo subscription reference exactly once from signed payment evidence", async () => {
    const testFixture = fixture({ providerSubscriptionRef: null, state: "active" });
    addCheckout(testFixture.database, { status: "completed" });
    const body = bodyFor({
      amount: 1500,
      eventType: "payment.succeeded",
      metadata: exactMetadata,
      paymentId: "pay_test_legacy_binding",
      subscriptionId: "sub_test_legacy_binding",
    });

    await expect(webhook(testFixture, body, "msg_legacy_binding")).resolves.toMatchObject({ processed: true, state: "active" });
    expect(testFixture.database.prepare("SELECT provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ providerSubscriptionRef: "sub_test_legacy_binding" });
    await expect(webhook(testFixture, body, "msg_legacy_binding")).resolves.toEqual({ duplicate: true, processed: false, state: "processed" });
    expect(testFixture.database.prepare("SELECT provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ providerSubscriptionRef: "sub_test_legacy_binding" });
    testFixture.database.close();
  });

  it("conflicts and audits a competing first-payment reference that wins before the guarded update", async () => {
    const testFixture = fixture();
    addCheckout(testFixture.database, { status: "open" });
    testFixture.platformDb.beforeNextBatch = () => {
      testFixture.database.exec(`
        UPDATE shop_subscriptions
        SET state = 'active', provider_subscription_ref = 'sub_test_competing_winner',
          trial_ends_at = NULL, version = version + 1, updated_at = '${NOW_ISO}'
        WHERE id = 'billing-sub-hardening';
        UPDATE billing_checkout_sessions
        SET status = 'completed', completed_at = '${NOW_ISO}', version = version + 1
        WHERE id = 'bchk-hardening';
      `);
    };
    const body = bodyFor({
      amount: 1500,
      eventType: "payment.succeeded",
      metadata: exactMetadata,
      paymentId: "pay_test_competing_loser",
      subscriptionId: "sub_test_competing_loser",
    });

    await expect(webhook(testFixture, body, "msg_competing_loser")).rejects.toMatchObject({ code: "billing_webhook_identity_mismatch", status: 409 });
    expect(testFixture.database.prepare("SELECT state, provider_subscription_ref AS providerSubscriptionRef FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ providerSubscriptionRef: "sub_test_competing_winner", state: "active" });
    expect(testFixture.database.prepare("SELECT status FROM billing_provider_events WHERE provider_code = 'dodo' AND provider_event_id = 'msg_competing_loser'").get()).toEqual({ status: "conflict" });
    expect(testFixture.database.prepare(`
      SELECT COUNT(*) AS count
      FROM subscription_events AS events
      INNER JOIN billing_provider_events AS provider_events ON provider_events.id = events.provider_event_id
      WHERE provider_events.provider_event_id = 'msg_competing_loser'
    `).get()).toEqual({ count: 0 });
    expect(testFixture.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'billing.webhook_identity_mismatch'").get()).toEqual({ count: 1 });
    await expect(webhook(testFixture, body, "msg_competing_loser")).resolves.toEqual({ duplicate: true, processed: false, state: "conflict" });
    expect(testFixture.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'billing.webhook_identity_mismatch'").get()).toEqual({ count: 1 });
    testFixture.database.close();
  });

  it.each([
    ["missing metadata", undefined],
    ["wrong shop metadata", { ...exactMetadata, shopId: "billing-shop-other" }],
    ["wrong subscription metadata", { ...exactMetadata, subscriptionId: "billing-sub-other" }],
  ])("rejects %s on initial payment", async (_label, metadata) => {
    const testFixture = fixture();
    addCheckout(testFixture.database, { status: "open" });
    const body = bodyFor({ amount: 1500, eventType: "payment.succeeded", metadata, paymentId: "pay_test_metadata", subscriptionId: "sub_test_metadata" });

    await expect(webhook(testFixture, body, `msg_metadata_${_label.replaceAll(" ", "_")}`)).rejects.toMatchObject({ code: "billing_webhook_identity_mismatch", status: 409 });
    expect(testFixture.database.prepare("SELECT state FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "trialing" });
    testFixture.database.close();
  });

  it("requires the provider checkout identity on initial payment", async () => {
    const testFixture = fixture();
    addCheckout(testFixture.database, { status: "open" });
    const body = bodyFor({ amount: 1500, checkoutSessionId: "", eventType: "payment.succeeded", metadata: exactMetadata, paymentId: "pay_test_missing_checkout", subscriptionId: "sub_test_missing_checkout" });
    await expect(webhook(testFixture, body, "msg_missing_checkout")).rejects.toMatchObject({ code: "billing_webhook_identity_mismatch", status: 409 });
    testFixture.database.close();
  });

  it("applies a signed provider plan_changed event to the requested plan", async () => {
    const testFixture = fixture({ providerSubscriptionRef: "sub_test_plan_change", state: "active" });
    addCheckout(testFixture.database, { status: "completed" });
    testFixture.database.prepare("UPDATE plan_prices SET provider_price_ref = 'prod_test_starter' WHERE id = 'price_starter_global_v1'").run();
    testFixture.database.prepare(`
      INSERT INTO subscription_change_requests (
        id, public_id, shop_id, subscription_id, current_plan_id, requested_plan_id,
        action, status, expected_subscription_version, reason_code, requested_by_user_id,
        reviewed_by_user_id, reviewed_at, idempotency_key_hash, request_hash, created_at, updated_at, version
      ) VALUES ('sreq-plan-change', 'sreq-plan-change', 'billing-shop-hardening', 'billing-sub-hardening',
        'plan_pro_v1', 'plan_starter_v1', 'change_plan', 'provider_pending', 1, 'seller_requested',
        'billing-user-hardening', 'billing-user-hardening', '${NOW_ISO}', 'sreq-plan-change-key', 'sreq-plan-change-hash', '${NOW_ISO}', '${NOW_ISO}', 1)
    `).run();
    const body = bodyFor({ eventType: "subscription.plan_changed", metadata: exactMetadata, productId: "prod_test_starter", subscriptionId: "sub_test_plan_change" });
    await expect(webhook(testFixture, body, "msg_plan_changed")).resolves.toMatchObject({ processed: true, state: "active" });
    expect(testFixture.database.prepare("SELECT plan_id AS planId FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ planId: "plan_starter_v1" });
    testFixture.database.close();
  });

  it("conflicts when the same webhook-id is replayed with a changed payload", async () => {
    const testFixture = fixture({ providerSubscriptionRef: "sub_test_active", state: "active" });
    addCheckout(testFixture.database, { status: "completed" });
    const firstBody = bodyFor({ eventType: "subscription.updated", metadata: exactMetadata, status: "active", subscriptionId: "sub_test_active" });
    const changedBody = bodyFor({ eventType: "subscription.updated", metadata: exactMetadata, status: "failed", subscriptionId: "sub_test_active" });

    await expect(webhook(testFixture, firstBody, "msg_same_id")).resolves.toMatchObject({ processed: true, state: "active" });
    await expect(webhook(testFixture, changedBody, "msg_same_id")).rejects.toMatchObject({ code: "billing_webhook_conflict", status: 409 });
    testFixture.database.close();
  });

  it("updates both renewal period boundaries from signed provider evidence", async () => {
    const testFixture = fixture({ providerSubscriptionRef: "sub_test_renewal", state: "active" });
    addCheckout(testFixture.database, { status: "completed" });
    const body = bodyFor({
      amount: 1500,
      eventType: "subscription.renewed",
      metadata: exactMetadata,
      periodEnd: "2026-10-01T00:00:00.000Z",
      periodStart: "2026-09-01T00:00:00.000Z",
      subscriptionId: "sub_test_renewal",
    });

    await expect(webhook(testFixture, body, "msg_renewal_period")).resolves.toMatchObject({ processed: true, state: "active" });
    expect(testFixture.database.prepare("SELECT current_period_start AS periodStart, current_period_end AS periodEnd FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z" });
    testFixture.database.close();
  });

  it("keeps one grace deadline across repeated renewal-failure evidence", async () => {
    const testFixture = fixture({ providerSubscriptionRef: "sub_test_grace", state: "active" });
    addCheckout(testFixture.database, { status: "completed" });
    const firstBody = bodyFor({ amount: 1500, eventType: "payment.failed", metadata: exactMetadata, paymentId: "pay_test_failed", subscriptionId: "sub_test_grace" });
    const secondBody = bodyFor({ eventType: "subscription.on_hold", metadata: exactMetadata, status: "on_hold", subscriptionId: "sub_test_grace", occurredAt: "2026-08-08T00:01:00.000Z" });

    await expect(webhook(testFixture, firstBody, "msg_grace_first")).resolves.toMatchObject({ processed: true, state: "grace_period" });
    const firstDeadline = (testFixture.database.prepare("SELECT grace_ends_at AS graceEndsAt FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get() as { graceEndsAt: string }).graceEndsAt;
    await expect(webhook(testFixture, secondBody, "msg_grace_second")).resolves.toMatchObject({ processed: true, state: "grace_period" });
    expect(testFixture.database.prepare("SELECT grace_ends_at AS graceEndsAt FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ graceEndsAt: firstDeadline });
    testFixture.database.close();
  });

  it("suspends expired grace periods exactly once when the helper is available", async () => {
    const testFixture = fixture({ providerSubscriptionRef: "sub_test_expiry", state: "active" });
    testFixture.database.prepare("UPDATE shop_subscriptions SET state = 'grace_period', grace_ends_at = '2026-08-08T00:00:00.000Z' WHERE id = 'billing-sub-hardening'").run();

    await expect(suspendExpiredBillingGracePeriods({ env: testFixture.env, now: new Date("2026-08-08T00:01:00.000Z") })).resolves.toBe(1);
    expect(testFixture.database.prepare("SELECT state, grace_ends_at AS graceEndsAt FROM shop_subscriptions WHERE id = 'billing-sub-hardening'").get()).toEqual({ state: "suspended", graceEndsAt: null });
    await expect(suspendExpiredBillingGracePeriods({ env: testFixture.env, now: new Date("2026-08-08T00:02:00.000Z") })).resolves.toBe(0);
    testFixture.database.close();
  });
});
