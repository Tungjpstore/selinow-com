import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { fireAutomationTriggers } from "../../src/lib/automation/rules/dispatcher";
import { createD1AutomationRuleRepository } from "../../src/lib/automation/rules/repository";
import type { AppBindings } from "../../src/lib/platform/bindings";

/**
 * End-to-end automation flow on a fully migrated database: a paid order fires
 * the trigger, the dispatcher matches the rule, the orchestrator executes the
 * automatic capability inline, and the tag executor persists the customer tag —
 * all linked back to the rule for audit.
 */

const NOW = "2026-08-16T00:00:00.000Z";
const SHOP = "shop-flow";
const CUSTOMER = "cust_flow_000000000000000000000000001";
const ORDER = "ord_flow_0000000000000000000000000001";
const RULE_ID = "rule_flow_000000000000000000000000001";

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

function seed(): void {
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(SHOP, "shop_public_flow", "shop-flow", "Flow shop", NOW, NOW);
  database.prepare(`
    INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Flow customer', 'vi', 'active', ?, ?)
  `).run(CUSTOMER, SHOP, `${CUSTOMER}@example.test`, NOW, NOW);
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
      currency, locale, checkout_subject_hash, order_token_hash, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'ORD-FLOW-1', 'web', 'completed', 'paid', 'unfulfilled', 500000, 0, 500000, 'VND', 'vi', ?, ?, ?, ?, ?)
  `).run(
    ORDER, `pub_${ORDER}`, SHOP, CUSTOMER,
    createHash("sha256").update(`subject:${ORDER}`).digest("hex"),
    createHash("sha256").update(`token:${ORDER}`).digest("hex"),
    "2026-08-17T00:00:00.000Z", NOW, NOW,
  );
}

async function seedTagRule(repository: ReturnType<typeof createD1AutomationRuleRepository>): Promise<void> {
  await repository.create({
    rule: {
      id: RULE_ID,
      shopId: SHOP,
      name: "Tag VIP buyers",
      triggerType: "order.paid",
      conditions: [{ field: "order.total_minor", operator: "gte", value: 100_000 }],
      actions: [{ type: "rule_tag_customer", config: { tag: "vip" } }],
      enabled: true,
      version: 1,
      lastTriggeredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "user-owner",
      updatedBy: "user-owner",
    },
    createIdempotencyKeyHash: createHash("sha256").update(`create:${RULE_ID}`).digest("hex"),
    createRequestHash: createHash("sha256").update(`request:${RULE_ID}`).digest("hex"),
  });
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  applyMigrations(database);
  seed();
  env = { LOG_LEVEL: "silent", PLATFORM_DB: createD1(database) } as unknown as AppBindings;
});

describe("paid order → rule → tag flow", () => {
  it("matches the rule, executes the tag action inline and links everything to the rule", async () => {
    const repository = createD1AutomationRuleRepository(createD1(database));
    await seedTagRule(repository);

    const result = await fireAutomationTriggers(env, {
      aggregateReference: `order:${ORDER}`,
      refs: { orderId: ORDER },
      shopId: SHOP,
      triggerType: "order.paid",
    });

    expect(result).toEqual({ dispatched: 1, matched: 1, skipped: false });

    const run = database.prepare("SELECT * FROM automation_rule_action_runs WHERE shop_id = ?").get(SHOP) as Record<string, unknown>;
    expect(run.rule_id).toBe(RULE_ID);
    expect(run.action_type).toBe("rule_tag_customer");
    expect(run.aggregate_reference).toBe(`order:${ORDER}`);

    // Automatic capabilities execute inline, so the task must already be settled.
    const task = database.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(run.task_id as string) as Record<string, unknown>;
    expect(task.status).toBe("succeeded");
    expect(task.capability_code).toBe("rule_tag_customer");
    expect(task.rule_id).toBe(RULE_ID);
    expect(task.input_reference).toBe(`action:rule-run/${String(run.id)}`);

    const tag = database.prepare("SELECT * FROM automation_customer_tags WHERE shop_id = ?").get(SHOP) as Record<string, unknown>;
    expect(tag.customer_id).toBe(CUSTOMER);
    expect(tag.tag).toBe("vip");
    expect(tag.source_rule_id).toBe(RULE_ID);

    const rule = database.prepare("SELECT last_triggered_at AS lastTriggeredAt FROM automation_rules WHERE id = ?").get(RULE_ID) as { lastTriggeredAt: string | null };
    expect(rule.lastTriggeredAt).not.toBeNull();
  });

  it("stays idempotent when the same payment event is replayed", async () => {
    const repository = createD1AutomationRuleRepository(createD1(database));
    await seedTagRule(repository);
    const event = {
      aggregateReference: `order:${ORDER}`,
      refs: { orderId: ORDER },
      shopId: SHOP,
      triggerType: "order.paid" as const,
    };

    await fireAutomationTriggers(env, event);
    const replay = await fireAutomationTriggers(env, event);

    expect(replay.dispatched).toBe(0);
    const counts = {
      runs: (database.prepare("SELECT COUNT(*) AS total FROM automation_rule_action_runs").get() as { total: number }).total,
      tags: (database.prepare("SELECT COUNT(*) AS total FROM automation_customer_tags").get() as { total: number }).total,
      tasks: (database.prepare("SELECT COUNT(*) AS total FROM automation_tasks").get() as { total: number }).total,
    };
    expect(counts).toEqual({ runs: 1, tags: 1, tasks: 1 });
  });

  it("does not tag when the condition rejects the order", async () => {
    const repository = createD1AutomationRuleRepository(createD1(database));
    await repository.create({
      rule: {
        id: RULE_ID,
        shopId: SHOP,
        name: "Tag whales only",
        triggerType: "order.paid",
        conditions: [{ field: "order.total_minor", operator: "gte", value: 10_000_000 }],
        actions: [{ type: "rule_tag_customer", config: { tag: "whale" } }],
        enabled: true,
        version: 1,
        lastTriggeredAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "user-owner",
        updatedBy: "user-owner",
      },
      createIdempotencyKeyHash: createHash("sha256").update(`create:${RULE_ID}`).digest("hex"),
      createRequestHash: createHash("sha256").update(`request:${RULE_ID}`).digest("hex"),
    });

    const result = await fireAutomationTriggers(env, {
      aggregateReference: `order:${ORDER}`,
      refs: { orderId: ORDER },
      shopId: SHOP,
      triggerType: "order.paid",
    });

    expect(result).toEqual({ dispatched: 0, matched: 0, skipped: false });
    const tags = (database.prepare("SELECT COUNT(*) AS total FROM automation_customer_tags").get() as { total: number }).total;
    expect(tags).toBe(0);
  });
});
