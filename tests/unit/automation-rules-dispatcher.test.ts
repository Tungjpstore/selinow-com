import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { fireAutomationTriggers } from "../../src/lib/automation/rules/dispatcher";
import { createD1AutomationRuleRepository } from "../../src/lib/automation/rules/repository";
import type { RuleAction, RuleCondition, RuleTriggerType } from "../../src/lib/automation/rules/types";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-08-16T00:00:00.000Z";
const SHOP_A = "shop-a";
const SHOP_B = "shop-b";
const CUSTOMER_A = "cust_00000000-0000-4000-8000-000000000001";
const ORDER_A = "ord_00000000-0000-4000-8000-000000000001";
const ORDER_B = "ord_00000000-0000-4000-8000-000000000002";

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

  all(): Promise<{ results: Record<string, unknown>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function createD1(database: DatabaseSync): D1Database {
  return {
    batch(statements: D1PreparedStatement[]) {
      return (async () => {
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
      })();
    },
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

let database: DatabaseSync;
let env: AppBindings;
let repository: ReturnType<typeof createD1AutomationRuleRepository>;
let ruleCounter = 0;

function expectedRunId(input: { aggregateReference: string; index: number; ruleId: string; shopId: string; triggerType: RuleTriggerType }): string {
  const digest = createHash("sha256")
    .update(`${input.shopId}|${input.ruleId}|${input.triggerType}|${input.aggregateReference}|${String(input.index)}`)
    .digest("hex");
  return `arun_${digest.slice(0, 48)}`;
}

function seedBase(): void {
  for (const shop of [
    { id: SHOP_A, publicId: "shop_public_a", slug: "shop-a" },
    { id: SHOP_B, publicId: "shop_public_b", slug: "shop-b" },
  ]) {
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency,
        timezone, readiness_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(shop.id, shop.publicId, shop.slug, shop.id, NOW, NOW);
  }
  database.prepare(`
    INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Customer', 'vi', 'active', ?, ?)
  `).run(CUSTOMER_A, SHOP_A, `${CUSTOMER_A}@example.test`, NOW, NOW);
}

async function seedRule(input: {
  actions?: readonly RuleAction[];
  conditions?: readonly RuleCondition[];
  enabled?: boolean;
  name?: string;
  shopId?: string;
  triggerType?: RuleTriggerType;
}): Promise<string> {
  ruleCounter += 1;
  const ruleId = `rule_00000000-0000-4000-8000-${String(ruleCounter).padStart(12, "0")}`;
  await repository.create({
    rule: {
      id: ruleId,
      shopId: input.shopId ?? SHOP_A,
      name: input.name ?? `Rule ${String(ruleCounter)}`,
      triggerType: input.triggerType ?? "order.paid",
      conditions: input.conditions ?? [],
      actions: input.actions ?? [{ type: "rule_create_task", config: {} }],
      enabled: input.enabled ?? true,
      version: 1,
      lastTriggeredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "user-owner-a",
      updatedBy: "user-owner-a",
    },
    createIdempotencyKeyHash: createHash("sha256").update(`create:${ruleId}`).digest("hex"),
    createRequestHash: createHash("sha256").update(`request:${ruleId}`).digest("hex"),
  });
  return ruleId;
}

function seedOrder(orderId: string, input: { fulfillmentStatus?: string; shopId?: string; totalMinor?: number } = {}): void {
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
      currency, locale, checkout_subject_hash, order_token_hash, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'web', 'completed', 'paid', ?, ?, 0, ?, 'VND', 'vi', ?, ?, ?, ?, ?)
  `).run(
    orderId, `pub_${orderId}`, input.shopId ?? SHOP_A, CUSTOMER_A, `ORD-${orderId.slice(-4)}`,
    input.fulfillmentStatus ?? "unfulfilled", input.totalMinor ?? 250_000, input.totalMinor ?? 250_000,
    createHash("sha256").update(`subject:${orderId}`).digest("hex"),
    createHash("sha256").update(`token:${orderId}`).digest("hex"),
    "2026-08-17T00:00:00.000Z", NOW, NOW,
  );
}

function seedOrderItem(input: { orderId: string; variantId: string }): void {
  database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title, variant_title,
      sku, unit_price_minor, quantity, line_total_minor, fulfillment_type, created_at
    ) VALUES (?, ?, ?, ?, ?, 'Product', 'Variant', ?, 100000, 1, 100000, 'license_key', ?)
  `).run(`item_${input.variantId}`, SHOP_A, input.orderId, `prod_${input.variantId}`, input.variantId, `sku-${input.variantId}`, NOW);
}

function seedStockFixture(input: { available: number; variantId: string }): void {
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-owner-a', 'owner-a@example.test', 'Owner A', 'active', ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO products (id, shop_id, slug, title, status, fulfillment_type, created_at, updated_at)
    VALUES (?, ?, ?, 'Product', 'active', 'license_key', ?, ?)
  `).run(`prod_${input.variantId}`, SHOP_A, `slug-${input.variantId}`, NOW, NOW);
  database.prepare(`
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, price_minor, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Variant', 100000, 'VND', 'active', ?, ?)
  `).run(input.variantId, SHOP_A, `prod_${input.variantId}`, `sku-${input.variantId}`, NOW, NOW);
  database.prepare(`
    INSERT INTO inventory_batches (id, shop_id, variant_id, source, total_count, accepted_count, rejected_count, created_by_user_id, created_at)
    VALUES (?, ?, ?, 'paste', ?, ?, 0, 'user-owner-a', ?)
  `).run(`batch_${input.variantId}`, SHOP_A, input.variantId, input.available, input.available, NOW);
  for (let index = 0; index < input.available; index += 1) {
    database.prepare(`
      INSERT INTO inventory_keys (id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64, key_version, key_fingerprint, created_at)
      VALUES (?, ?, ?, ?, 'available', 'AAAA', 'BBBB', '1', ?, ?)
    `).run(`key_${input.variantId}_${String(index)}`, SHOP_A, input.variantId, `batch_${input.variantId}`, `fp_${input.variantId}_${String(index)}`, NOW);
  }
}

/** Plans + subscription drive the billing period used by automation quota. */
function seedPlanWithLimit(automationRuns: number): void {
  database.prepare(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan_test', 'test', 'Test', '{}', ?, ?, ?)
  `).run(JSON.stringify({ automation_runs: automationRuns }), NOW, NOW);
  database.prepare(`
    INSERT INTO shop_subscriptions (
      id, shop_id, plan_id, state, current_period_start, current_period_end, created_at, updated_at
    ) VALUES ('sub_test', ?, 'plan_test', 'active', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?, ?)
  `).run(SHOP_A, NOW, NOW);
}

function paidEvent(orderId: string) {
  return {
    aggregateReference: `order:${orderId}`,
    refs: { orderId },
    shopId: SHOP_A,
    triggerType: "order.paid" as const,
  };
}

function countRows(table: string, where = "1=1"): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`).get() as { total: number };
  return row.total;
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  applyMigrations(database);
  seedBase();
  env = { LOG_LEVEL: "silent", PLATFORM_DB: createD1(database) } as unknown as AppBindings;
  repository = createD1AutomationRuleRepository(createD1(database));
  ruleCounter = 0;
});

describe("order.paid dispatch", () => {
  it("matches conditions, creates a deterministic run and a waiting_user task", async () => {
    const ruleId = await seedRule({
      conditions: [{ field: "order.total_minor", operator: "gte", value: 100_000 }],
    });
    seedOrder(ORDER_A);

    const result = await fireAutomationTriggers(env, paidEvent(ORDER_A));

    expect(result).toEqual({ dispatched: 1, matched: 1, skipped: false });
    const runId = expectedRunId({ aggregateReference: `order:${ORDER_A}`, index: 0, ruleId, shopId: SHOP_A, triggerType: "order.paid" });
    const run = database.prepare("SELECT * FROM automation_rule_action_runs WHERE id = ?").get(runId) as Record<string, unknown>;
    expect(run.task_id).toBeTypeOf("string");
    expect((JSON.parse(String(run.event_payload_json)) as Record<string, unknown>)["order.number"]).toBe(`ORD-${ORDER_A.slice(-4)}`);
    expect(JSON.parse(String(run.action_config_json))).toEqual({});
    const task = database.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(run.task_id as string) as Record<string, unknown>;
    expect(task.status).toBe("waiting_user");
    expect(task.capability_code).toBe("rule_create_task");
    expect(task.rule_id).toBe(ruleId);
    expect(task.input_reference).toBe(`action:rule-run/${runId}`);
    const rule = database.prepare("SELECT last_triggered_at AS lastTriggeredAt FROM automation_rules WHERE id = ?").get(ruleId) as { lastTriggeredAt: string | null };
    expect(rule.lastTriggeredAt).not.toBeNull();
  });

  it("dispatches only once when the same event fires again", async () => {
    await seedRule({});
    seedOrder(ORDER_A);

    await fireAutomationTriggers(env, paidEvent(ORDER_A));
    const replay = await fireAutomationTriggers(env, paidEvent(ORDER_A));

    expect(replay.dispatched).toBe(0);
    expect(countRows("automation_rule_action_runs")).toBe(1);
    expect(countRows("automation_tasks")).toBe(1);
  });

  it("skips rules whose conditions do not match", async () => {
    await seedRule({
      conditions: [{ field: "order.total_minor", operator: "gte", value: 10_000_000 }],
    });
    seedOrder(ORDER_A, { totalMinor: 250_000 });

    const result = await fireAutomationTriggers(env, paidEvent(ORDER_A));

    expect(result).toEqual({ dispatched: 0, matched: 0, skipped: false });
    expect(countRows("automation_rule_action_runs")).toBe(0);
    const rule = database.prepare("SELECT last_triggered_at AS lastTriggeredAt FROM automation_rules").get() as { lastTriggeredAt: string | null };
    expect(rule.lastTriggeredAt).toBeNull();
  });

  it("never matches disabled, foreign-shop or different-trigger rules", async () => {
    await seedRule({ enabled: false });
    await seedRule({ shopId: SHOP_B });
    await seedRule({ triggerType: "order.fulfilled" });
    seedOrder(ORDER_A);

    const result = await fireAutomationTriggers(env, paidEvent(ORDER_A));

    expect(result).toEqual({ dispatched: 0, matched: 0, skipped: false });
    expect(countRows("automation_rule_action_runs")).toBe(0);
  });

  it("reports skipped when the referenced order does not exist", async () => {
    await seedRule({});

    const result = await fireAutomationTriggers(env, paidEvent("ord_missing"));

    expect(result).toEqual({ dispatched: 0, matched: 0, skipped: true });
  });

  it("never throws on corrupted stored conditions and degrades to match-all", async () => {
    const ruleId = await seedRule({});
    seedOrder(ORDER_A);
    // Writes are validated, so only direct tampering can produce this. The
    // repository degrades unparsable conditions to "no conditions" (match all)
    // instead of throwing, keeping the commerce path alive.
    database.prepare(
      "UPDATE automation_rules SET conditions_json = '[{\"field\":123,\"operator\":\"bogus\",\"value\":1}]' WHERE id = ?",
    ).run(ruleId);

    await expect(fireAutomationTriggers(env, paidEvent(ORDER_A))).resolves.toEqual({ dispatched: 1, matched: 1, skipped: false });
  });
});

describe("other triggers", () => {
  it("fires order.fulfilled only when the order is fully fulfilled", async () => {
    await seedRule({ triggerType: "order.fulfilled" });
    seedOrder(ORDER_A, { fulfillmentStatus: "unfulfilled" });
    const event = { ...paidEvent(ORDER_A), triggerType: "order.fulfilled" as const };

    expect(await fireAutomationTriggers(env, event)).toEqual({ dispatched: 0, matched: 0, skipped: true });
    expect(countRows("automation_rule_action_runs")).toBe(0);

    database.prepare("UPDATE orders SET fulfillment_status = 'fulfilled' WHERE id = ?").run(ORDER_A);
    expect(await fireAutomationTriggers(env, event)).toEqual({ dispatched: 1, matched: 1, skipped: false });
  });

  it("builds the payment.reason field for payment.failed events", async () => {
    await seedRule({
      conditions: [{ field: "payment.reason", operator: "eq", value: "card_declined" }],
      triggerType: "payment.failed",
    });
    seedOrder(ORDER_A);

    const result = await fireAutomationTriggers(env, {
      aggregateReference: `order:${ORDER_A}`,
      refs: { orderId: ORDER_A, reason: "card_declined" },
      shopId: SHOP_A,
      triggerType: "payment.failed",
    });

    expect(result.matched).toBe(1);
    const run = database.prepare("SELECT event_payload_json AS payload FROM automation_rule_action_runs").get() as { payload: string };
    expect((JSON.parse(run.payload) as Record<string, unknown>)["payment.reason"]).toBe("card_declined");
  });

  it("fires customer.created with locale and channel payload fields", async () => {
    await seedRule({ triggerType: "customer.created" });

    const result = await fireAutomationTriggers(env, {
      aggregateReference: `customer:${CUSTOMER_A}`,
      customerId: CUSTOMER_A,
      refs: { channel: "checkout" },
      shopId: SHOP_A,
      triggerType: "customer.created",
    });

    expect(result).toEqual({ dispatched: 1, matched: 1, skipped: false });
    const run = database.prepare("SELECT event_payload_json AS payload FROM automation_rule_action_runs").get() as { payload: string };
    expect(JSON.parse(run.payload)).toMatchObject({
      "customer.channel": "checkout",
      "customer.id": CUSTOMER_A,
      "customer.locale": "vi",
    });
  });
});

describe("quota and derived stock events", () => {
  it("stops dispatching once the plan automation_runs quota is exhausted", async () => {
    seedPlanWithLimit(1);
    await seedRule({});
    seedOrder(ORDER_A);
    seedOrder(ORDER_B);

    expect(await fireAutomationTriggers(env, paidEvent(ORDER_A))).toEqual({ dispatched: 1, matched: 1, skipped: false });
    // Second order matches the rule but the quota gate skips run creation.
    const second = await fireAutomationTriggers(env, paidEvent(ORDER_B));

    expect(second).toEqual({ dispatched: 0, matched: 1, skipped: false });
    expect(countRows("automation_rule_action_runs")).toBe(1);
    expect(countRows("usage_events")).toBe(1);
  });

  it("derives inventory.low_stock events from paid orders with managed stock", async () => {
    database.prepare(`
      INSERT INTO shop_settings (shop_id, branding_json, storefront_json, low_stock_threshold, updated_at)
      VALUES (?, '{}', '{}', 5, ?)
    `).run(SHOP_A, NOW);
    seedStockFixture({ available: 2, variantId: "var_low" });
    // Unmanaged variants (no inventory keys) never produce stock events.
    database.prepare(`
      INSERT INTO products (id, shop_id, slug, title, status, fulfillment_type, created_at, updated_at)
      VALUES ('prod_var_manual', ?, 'slug-manual', 'Manual', 'active', 'manual', ?, ?)
    `).run(SHOP_A, NOW, NOW);
    database.prepare(`
      INSERT INTO product_variants (id, shop_id, product_id, sku, title, price_minor, currency, status, created_at, updated_at)
      VALUES ('var_manual', ?, 'prod_var_manual', 'sku-manual', 'Manual', 100000, 'VND', 'active', ?, ?)
    `).run(SHOP_A, NOW, NOW);

    await seedRule({ triggerType: "inventory.low_stock" });
    await seedRule({ triggerType: "order.paid" });
    seedOrder(ORDER_A);
    seedOrderItem({ orderId: ORDER_A, variantId: "var_low" });
    seedOrderItem({ orderId: ORDER_A, variantId: "var_manual" });

    const result = await fireAutomationTriggers(env, paidEvent(ORDER_A));

    expect(result).toEqual({ dispatched: 2, matched: 2, skipped: false });
    const stockRun = database.prepare(
      "SELECT aggregate_reference AS aggregateReference FROM automation_rule_action_runs WHERE trigger_type = 'inventory.low_stock'",
    ).get() as { aggregateReference: string };
    expect(stockRun.aggregateReference).toBe("stock:var_low:5");
    expect(countRows("automation_rule_action_runs", "trigger_type = 'order.paid'")).toBe(1);
  });
});
