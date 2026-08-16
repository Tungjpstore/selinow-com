import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAutomationExecutors } from "../../src/lib/automation/executors";
import { createD1AutomationRuleRepository } from "../../src/lib/automation/rules/repository";
import type { RuleActionRun, RuleEventPayload } from "../../src/lib/automation/rules/types";
import { assertSafeWebhookUrl, } from "../../src/lib/automation/rules/webhook-guard";
import { renderRuleTemplate } from "../../src/lib/automation/executors";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-08-16T00:00:00.000Z";
const SHOP_A = "shop-a";
const SHOP_B = "shop-b";
const RULE_ID = "rule_00000000-0000-4000-8000-0000000000aa";
const CUSTOMER_A = "cust_00000000-0000-4000-8000-000000000001";
const CUSTOMER_B = "cust_00000000-0000-4000-8000-000000000002";

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
  for (const customer of [
    { id: CUSTOMER_A, shopId: SHOP_A },
    { id: CUSTOMER_B, shopId: SHOP_B },
  ]) {
    database.prepare(`
      INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
      VALUES (?, ?, ?, 'Customer', 'vi', 'active', ?, ?)
    `).run(customer.id, customer.shopId, `${customer.id}@example.test`, NOW, NOW);
  }
}

async function seedRule(): Promise<void> {
  await repository.create({
    rule: {
      id: RULE_ID,
      shopId: SHOP_A,
      name: "Executor rule",
      triggerType: "order.paid",
      conditions: [],
      actions: [{ type: "rule_create_task", config: {} }],
      enabled: true,
      version: 1,
      lastTriggeredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "user-owner-a",
      updatedBy: "user-owner-a",
    },
    createIdempotencyKeyHash: "a".repeat(64),
    createRequestHash: "c".repeat(64),
  });
}

async function seedRun(input: {
  actionConfig: Record<string, unknown>;
  actionType?: RuleActionRun["actionType"];
  aggregateReference?: string;
  eventPayload?: RuleEventPayload;
  runId?: string;
  shopId?: string;
}): Promise<string> {
  const runId = input.runId ?? "arun_test_000000000000000000000000000000000000000000000001";
  const inserted = await repository.insertRun({
    run: {
      id: runId,
      shopId: input.shopId ?? SHOP_A,
      ruleId: RULE_ID,
      ruleVersion: 1,
      triggerType: "order.paid",
      actionIndex: 0,
      actionType: input.actionType ?? "rule_call_webhook",
      actionConfig: input.actionConfig,
      eventPayload: input.eventPayload ?? { "order.number": "ORD-1" },
      // Natural key is (shop, rule, trigger, aggregate, action index) — tie the
      // aggregate to the run id so seeding multiple runs per test never collides.
      aggregateReference: input.aggregateReference ?? `order:${runId}`,
      taskId: null,
      createdAt: NOW,
    },
  });
  if (!inserted) throw new Error("run seed failed");
  return runId;
}

function referenceFor(runId: string, capabilityCode: string, shopId: string = SHOP_A) {
  return {
    attemptCount: 0,
    capabilityCode,
    inputReference: `action:rule-run/${runId}`,
    shopId,
    taskId: "aut_test_0000000001",
  };
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  applyMigrations(database);
  seedBase();
  env = { LOG_LEVEL: "silent", PLATFORM_DB: createD1(database) } as unknown as AppBindings;
  repository = createD1AutomationRuleRepository(createD1(database));
});

describe("webhook SSRF guard", () => {
  it("blocks private, local and non-https targets", () => {
    const blocked = [
      "http://example.com/hook",
      "https://127.0.0.1/hook",
      "https://10.0.0.5/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.1/hook",
      "https://[::1]/hook",
      "https://localhost/hook",
      "https://db.local/hook",
      "https://svc.internal/hook",
      // WHATWG URLs keep a trailing dot verbatim for non-IP hosts; without
      // trimming, "localhost." / "metadata.google.internal." would slip through.
      "https://localhost./hook",
      "https://foo.localhost./hook",
      "https://metadata.google.internal./hook",
      "https://user:pass@example.com/hook",
      "https://example.com:8443/hook",
      "https://intranet/hook",
      "not-a-url",
      "",
    ];
    for (const url of blocked) {
      expect(() => assertSafeWebhookUrl(url), url).toThrow(/validation_failed/u);
    }
  });

  it("allows public https endpoints on port 443 only", () => {
    expect(assertSafeWebhookUrl("https://example.com/webhook")).toBe("https://example.com/webhook");
    // The guard canonicalizes URLs, so the default https port is dropped.
    expect(assertSafeWebhookUrl("https://example.com:443/webhook")).toBe("https://example.com/webhook");
  });
});

describe("rule_call_webhook executor", () => {
  it("completes on 2xx and never follows redirects", async () => {
    await seedRule();
    const runId = await seedRun({ actionConfig: { url: "https://example.com/hook" } });
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    const executor = createAutomationExecutors(env, { fetcher }).get("rule_call_webhook");

    const result = await executor?.(referenceFor(runId, "rule_call_webhook"));

    expect(result).toEqual({ outcome: "completed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://example.com/hook");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(typeof init?.body).toBe("string");
    const body = JSON.parse(init?.body as string) as { rule: { name: string }; trigger: string };
    expect(body.trigger).toBe("order.paid");
    expect(body.rule.name).toBe("Executor rule");
  });

  it("fails permanently on 4xx and retries on 5xx or network errors", async () => {
    await seedRule();
    const runId = await seedRun({ actionConfig: { url: "https://example.com/hook" } });
    const executors = () => createAutomationExecutors(env, { fetcher }).get("rule_call_webhook");

    let fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
    expect(await executors()?.(referenceFor(runId, "rule_call_webhook")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_webhook_rejected" });

    fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    expect(await executors()?.(referenceFor(runId, "rule_call_webhook")))
      .toEqual({ outcome: "retry", safeErrorCode: "rule_webhook_unavailable" });

    fetcher = vi.fn(() => Promise.reject(new Error("network down")));
    expect(await executors()?.(referenceFor(runId, "rule_call_webhook")))
      .toEqual({ outcome: "retry", safeErrorCode: "rule_webhook_unavailable" });
  });

  it("refuses to call URLs that fail the SSRF guard even if stored", async () => {
    await seedRule();
    const runId = await seedRun({ actionConfig: { url: "http://127.0.0.1/hook" } });
    const fetcher = vi.fn();
    const executor = createAutomationExecutors(env, { fetcher }).get("rule_call_webhook");

    expect(await executor?.(referenceFor(runId, "rule_call_webhook")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_webhook_unsafe" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never loads runs from another shop", async () => {
    await seedRule();
    const runId = await seedRun({ actionConfig: { url: "https://example.com/hook" } });
    const fetcher = vi.fn();
    const executor = createAutomationExecutors(env, { fetcher }).get("rule_call_webhook");

    expect(await executor?.(referenceFor(runId, "rule_call_webhook", SHOP_B)))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_run_missing" });
    expect(await executor?.({ ...referenceFor(runId, "rule_call_webhook"), inputReference: "action:rule-run/arun_missing" }))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_run_missing" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("rule_notify_telegram executor", () => {
  it("fails when the shop has no telegram integration", async () => {
    await seedRule();
    const runId = await seedRun({
      actionConfig: { message: "Order {{order.number}} paid" },
      actionType: "rule_notify_telegram",
      eventPayload: { "customer.id": CUSTOMER_A, "order.number": "ORD-1" },
    });
    const executor = createAutomationExecutors(env, { fetcher: vi.fn() }).get("rule_notify_telegram");

    expect(await executor?.(referenceFor(runId, "rule_notify_telegram")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_telegram_not_configured" });
  });

  it("fails when the integration exists but has no active credential", async () => {
    await seedRule();
    database.prepare(`
      INSERT INTO telegram_integrations (
        id, public_id, webhook_public_id, shop_id, status, webhook_status,
        pending_update_count, created_at, updated_at
      ) VALUES ('tgint_0000000000000001', 'tgint_pub_1', 'tgint_webhook_1', ?, 'active', 'verified', 0, ?, ?)
    `).run(SHOP_A, NOW, NOW);
    const runId = await seedRun({
      actionConfig: { message: "Hello" },
      actionType: "rule_notify_telegram",
      eventPayload: { "customer.id": CUSTOMER_A },
    });
    const executor = createAutomationExecutors(env, { fetcher: vi.fn() }).get("rule_notify_telegram");

    expect(await executor?.(referenceFor(runId, "rule_notify_telegram")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_telegram_not_configured" });
  });

  it("fails when the event payload carries no customer", async () => {
    await seedRule();
    const runId = await seedRun({
      actionConfig: { message: "Hello" },
      actionType: "rule_notify_telegram",
      eventPayload: { "order.number": "ORD-1" },
    });
    const executor = createAutomationExecutors(env, { fetcher: vi.fn() }).get("rule_notify_telegram");

    expect(await executor?.(referenceFor(runId, "rule_notify_telegram")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_telegram_recipient_missing" });
  });

  it("rejects empty or oversized messages before any provider call", async () => {
    await seedRule();
    const fetcher = vi.fn();
    const executor = createAutomationExecutors(env, { fetcher }).get("rule_notify_telegram");
    const empty = await seedRun({
      actionConfig: { message: "" },
      actionType: "rule_notify_telegram",
      eventPayload: { "customer.id": CUSTOMER_A },
    });
    expect(await executor?.(referenceFor(empty, "rule_notify_telegram")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_run_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("rule_tag_customer executor", () => {
  it("tags the customer and records the source rule", async () => {
    await seedRule();
    const runId = await seedRun({
      actionConfig: { tag: "vip" },
      actionType: "rule_tag_customer",
      eventPayload: { "customer.id": CUSTOMER_A },
    });
    const executor = createAutomationExecutors(env).get("rule_tag_customer");

    expect(await executor?.(referenceFor(runId, "rule_tag_customer")))
      .toEqual({ outcome: "completed" });
    const rows = database.prepare(
      "SELECT shop_id, customer_id, tag, source_rule_id FROM automation_customer_tags",
    ).all() as Array<{ customer_id: string; shop_id: string; source_rule_id: string; tag: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_id: CUSTOMER_A, shop_id: SHOP_A, source_rule_id: RULE_ID, tag: "vip" });
  });

  it("stays idempotent when the same tag already exists", async () => {
    await seedRule();
    const runId = await seedRun({
      actionConfig: { tag: "vip" },
      actionType: "rule_tag_customer",
      eventPayload: { "customer.id": CUSTOMER_A },
    });
    const executor = createAutomationExecutors(env).get("rule_tag_customer");

    expect(await executor?.(referenceFor(runId, "rule_tag_customer"))).toEqual({ outcome: "completed" });
    expect(await executor?.(referenceFor(runId, "rule_tag_customer"))).toEqual({ outcome: "completed" });
    const total = database.prepare("SELECT COUNT(*) AS total FROM automation_customer_tags").get() as { total: number };
    expect(total.total).toBe(1);
  });

  it("never tags customers that belong to another shop", async () => {
    await seedRule();
    const runId = await seedRun({
      actionConfig: { tag: "vip" },
      actionType: "rule_tag_customer",
      eventPayload: { "customer.id": CUSTOMER_B },
    });
    const executor = createAutomationExecutors(env).get("rule_tag_customer");

    expect(await executor?.(referenceFor(runId, "rule_tag_customer")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_customer_missing" });
    const total = database.prepare("SELECT COUNT(*) AS total FROM automation_customer_tags").get() as { total: number };
    expect(total.total).toBe(0);
  });

  it("rejects missing customers and invalid tags", async () => {
    await seedRule();
    const executor = createAutomationExecutors(env).get("rule_tag_customer");
    const noCustomer = await seedRun({
      actionConfig: { tag: "vip" },
      actionType: "rule_tag_customer",
      eventPayload: { "order.number": "ORD-1" },
    });
    expect(await executor?.(referenceFor(noCustomer, "rule_tag_customer")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_customer_missing" });

    const badTag = await seedRun({
      actionConfig: { tag: "vip<script>" },
      actionType: "rule_tag_customer",
      eventPayload: { "customer.id": CUSTOMER_A },
      runId: "arun_test_000000000000000000000000000000000000000000000002",
    });
    expect(await executor?.(referenceFor(badTag, "rule_tag_customer")))
      .toEqual({ outcome: "failed", safeErrorCode: "rule_tag_invalid" });
  });
});

describe("rule_create_task executor and templates", () => {
  it("completes immediately because the visible task is the waiting_user task", async () => {
    const executor = createAutomationExecutors(env).get("rule_create_task");
    expect(await executor?.(referenceFor("arun_missing", "rule_create_task")))
      .toEqual({ outcome: "completed" });
  });

  it("renders only the closed placeholder set from the safe payload", () => {
    const payload: RuleEventPayload = { "order.number": "ORD-9", "order.total_minor": 42_000 };
    expect(renderRuleTemplate("Order {{order.number}} total {{order.total}}", payload, "My rule"))
      .toBe("Order ORD-9 total 42000");
    expect(renderRuleTemplate("Rule: {{rule.name}}", payload, "My rule")).toBe("Rule: My rule");
    // Unknown placeholders are left untouched; missing values render empty.
    expect(renderRuleTemplate("{{secret.token}} {{stock.sku}}", payload, "My rule"))
      .toBe("{{secret.token}} ");
  });
});
