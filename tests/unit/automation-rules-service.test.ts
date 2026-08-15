import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import { TenantIsolationHarness } from "../helpers/tenant-harness";

const dependencies = vi.hoisted(() => ({
  getShopForMember: vi.fn(),
}));

vi.mock("../../src/lib/tenants/store", () => ({
  getShopForMember: dependencies.getShopForMember,
}));

import type { AppBindings } from "../../src/lib/platform/bindings";
import {
  createAutomationRule,
  deleteAutomationRule,
  getAutomationRule,
  listAutomationRules,
  toggleAutomationRule,
  updateAutomationRule,
} from "../../src/lib/automation/rules/service";

const NOW = "2026-08-16T00:00:00.000Z";
const SHOP_A = "shop-a";
const SHOP_B = "shop-b";
const SHOP_A_PUBLIC = "shop_public_a";
const SHOP_B_PUBLIC = "shop_public_b";
const OWNER_A = "user_owner_a";
const OWNER_B = "user_owner_b";
const OUTSIDER = "user_outsider";

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

function seedShops(database: DatabaseSync): void {
  for (const shop of [
    { id: SHOP_A, publicId: SHOP_A_PUBLIC, slug: "shop-a" },
    { id: SHOP_B, publicId: SHOP_B_PUBLIC, slug: "shop-b" },
  ]) {
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency,
        timezone, readiness_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(shop.id, shop.publicId, shop.slug, shop.id, NOW, NOW);
  }
}

let database: DatabaseSync;
let env: AppBindings;
let harness: TenantIsolationHarness;
let planLimits: Record<string, unknown>;

function ruleDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Tag VIP customers",
    triggerType: "order.paid",
    conditions: [{ field: "order.total_minor", operator: "gte", value: 100_000 }],
    actions: [{ type: "rule_tag_customer", config: { tag: "vip" } }],
    ...overrides,
  };
}

function createInput(overrides: {
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  shopPublicId?: string;
  userId?: string;
} = {}) {
  return {
    body: overrides.body ?? ruleDraft(),
    env,
    idempotencyKey: overrides.idempotencyKey ?? "rule-create-00000001",
    requestId: "request_rules_service",
    shopPublicId: overrides.shopPublicId ?? SHOP_A_PUBLIC,
    userId: overrides.userId ?? OWNER_A,
  };
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  applyMigrations(database);
  seedShops(database);
  env = { PLATFORM_DB: createD1(database), SESSION_SECRET: "test-session-secret" } as unknown as AppBindings;

  harness = new TenantIsolationHarness();
  harness.addShop({ id: SHOP_A, name: "Shop A", ownerUserId: OWNER_A });
  harness.addShop({ id: SHOP_B, name: "Shop B", ownerUserId: OWNER_B });
  planLimits = { automation_rules: 10 };

  dependencies.getShopForMember.mockReset();
  // Membership resolution goes through the tenant harness: any user who does
  // not own the shop receives authorization_denied (403), mirroring how
  // support/viewer roles never pass automation:manage.
  dependencies.getShopForMember.mockImplementation((input: { shopPublicId: string; userId: string }) => {
    const shopId = input.shopPublicId === SHOP_A_PUBLIC ? SHOP_A : input.shopPublicId === SHOP_B_PUBLIC ? SHOP_B : null;
    if (shopId === null) return Promise.reject(new AppError("shop_not_found", 404));
    const shop = harness.readShop(input.userId, shopId);
    return Promise.resolve({ row: { shop_id: shop.id }, shop: { limits: planLimits } } as never);
  });
});

describe("automation rules service lifecycle", () => {
  it("creates, reads, updates, toggles and deletes a rule with version bumps", async () => {
    const created = await createAutomationRule(createInput());
    expect(created.replayed).toBe(false);
    expect(created.rule.version).toBe(1);
    expect(created.rule.enabled).toBe(true);
    expect(created.rule.lastTriggeredAt).toBeNull();
    expect(created.rule.lastRuns).toEqual([]);
    const ruleId = created.rule.id;

    const read = await getAutomationRule({ env, ruleId, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    expect(read.rule.name).toBe("Tag VIP customers");
    expect(read.rule.actions).toEqual([{ config: { tag: "vip" }, type: "rule_tag_customer" }]);

    const updated = await updateAutomationRule({
      body: { name: "Tag VIP customers v2" },
      env,
      expectedVersion: 1,
      requestId: "request_rules_service",
      ruleId,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    });
    expect(updated.rule.version).toBe(2);
    expect(updated.rule.name).toBe("Tag VIP customers v2");

    const toggled = await toggleAutomationRule({
      enabled: false,
      env,
      expectedVersion: 2,
      requestId: "request_rules_service",
      ruleId,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    });
    expect(toggled.rule.version).toBe(3);
    expect(toggled.rule.enabled).toBe(false);

    const listed = await listAutomationRules({ env, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    expect(listed.rules).toHaveLength(1);

    await deleteAutomationRule({
      env,
      expectedVersion: 3,
      requestId: "request_rules_service",
      ruleId,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    });
    await expect(getAutomationRule({ env, ruleId, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A }))
      .rejects.toMatchObject({ code: "automation_rule_not_found", status: 404 });
  });

  it("replays an identical create with the same idempotency key", async () => {
    const first = await createAutomationRule(createInput());
    const replay = await createAutomationRule(createInput());
    expect(replay.replayed).toBe(true);
    expect(replay.rule.id).toBe(first.rule.id);
    const listed = await listAutomationRules({ env, shopPublicId: SHOP_A_PUBLIC, userId: OWNER_A });
    expect(listed.rules).toHaveLength(1);
  });

  it("rejects a replayed key whose body differs from the original create", async () => {
    await createAutomationRule(createInput());
    await expect(createAutomationRule(createInput({ body: ruleDraft({ name: "Different name" }) })))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("rejects missing or malformed idempotency keys", async () => {
    await expect(createAutomationRule({
      body: ruleDraft(),
      env,
      idempotencyKey: null,
      requestId: "request_rules_service",
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    })).rejects.toMatchObject({ code: "validation_failed", status: 400 });
    await expect(createAutomationRule(createInput({ idempotencyKey: "inv@lid key!" })))
      .rejects.toMatchObject({ code: "validation_failed", status: 400 });
    await expect(createAutomationRule(createInput({ idempotencyKey: "short" })))
      .rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });
});

describe("automation rules plan quota", () => {
  it("enforces the automation_rules plan limit", async () => {
    planLimits = { automation_rules: 1 };
    await createAutomationRule(createInput());
    await expect(createAutomationRule(createInput({ idempotencyKey: "rule-create-00000002" })))
      .rejects.toMatchObject({ code: "automation_rule_limit_reached", status: 429 });
  });

  it("fails closed when the plan does not define a rule limit", async () => {
    planLimits = {};
    await expect(createAutomationRule(createInput()))
      .rejects.toMatchObject({ code: "quota_unavailable", status: 503 });
  });

  it("fails closed when the configured limit is not a safe integer", async () => {
    planLimits = { automation_rules: "unlimited" };
    await expect(createAutomationRule(createInput()))
      .rejects.toMatchObject({ code: "quota_unavailable", status: 503 });
  });
});

describe("automation rules tenant isolation and roles", () => {
  it("never reveals another shop's rule (cross-tenant reads 404)", async () => {
    const created = await createAutomationRule(createInput());
    await expect(getAutomationRule({ env, ruleId: created.rule.id, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B }))
      .rejects.toMatchObject({ code: "automation_rule_not_found", status: 404 });
    const listed = await listAutomationRules({ env, shopPublicId: SHOP_B_PUBLIC, userId: OWNER_B });
    expect(listed.rules).toEqual([]);
  });

  it("denies non-owners (support/viewer equivalent) on reads and mutations", async () => {
    const created = await createAutomationRule(createInput());
    await expect(listAutomationRules({ env, shopPublicId: SHOP_A_PUBLIC, userId: OUTSIDER }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(getAutomationRule({ env, ruleId: created.rule.id, shopPublicId: SHOP_A_PUBLIC, userId: OUTSIDER }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(deleteAutomationRule({
      env,
      expectedVersion: 1,
      requestId: "request_rules_service",
      ruleId: created.rule.id,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OUTSIDER,
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });
});

describe("automation rules optimistic concurrency", () => {
  it("rejects update/toggle/delete with a stale expectedVersion", async () => {
    const created = await createAutomationRule(createInput());
    const ruleId = created.rule.id;
    await expect(updateAutomationRule({
      body: { name: "Stale update" },
      env,
      expectedVersion: 9,
      requestId: "request_rules_service",
      ruleId,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    })).rejects.toMatchObject({ code: "automation_version_conflict", status: 409 });
    await expect(toggleAutomationRule({
      enabled: false,
      env,
      expectedVersion: 9,
      requestId: "request_rules_service",
      ruleId,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    })).rejects.toMatchObject({ code: "automation_version_conflict", status: 409 });
    await expect(deleteAutomationRule({
      env,
      expectedVersion: 9,
      requestId: "request_rules_service",
      ruleId,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    })).rejects.toMatchObject({ code: "automation_version_conflict", status: 409 });
  });

  it("rejects invalid expectedVersion values before touching storage", async () => {
    const created = await createAutomationRule(createInput());
    await expect(updateAutomationRule({
      body: { name: "Bad version" },
      env,
      expectedVersion: 0,
      requestId: "request_rules_service",
      ruleId: created.rule.id,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    })).rejects.toMatchObject({ code: "automation_expected_version_invalid", status: 400 });
  });

  it("rejects an empty PATCH body", async () => {
    const created = await createAutomationRule(createInput());
    await expect(updateAutomationRule({
      body: {},
      env,
      expectedVersion: 1,
      requestId: "request_rules_service",
      ruleId: created.rule.id,
      shopPublicId: SHOP_A_PUBLIC,
      userId: OWNER_A,
    })).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });
});

describe("automation rules draft validation", () => {
  it("rejects unknown triggers and missing names", async () => {
    await expect(createAutomationRule(createInput({ body: ruleDraft({ triggerType: "order.shipped" }) })))
      .rejects.toMatchObject({ code: "validation_failed", status: 400 });
    await expect(createAutomationRule(createInput({ body: ruleDraft({ name: "" }) })))
      .rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("rejects unsafe webhook URLs at draft time", async () => {
    const body = ruleDraft({
      actions: [{ type: "rule_call_webhook", config: { url: "http://example.com/hook" } }],
    });
    await expect(createAutomationRule(createInput({ body })))
      .rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("rejects invalid tags and customer actions on non-customer triggers", async () => {
    await expect(createAutomationRule(createInput({
      body: ruleDraft({ actions: [{ type: "rule_tag_customer", config: { tag: "vip<script>" } }] }),
    }))).rejects.toMatchObject({ code: "validation_failed", status: 400 });

    // payment.failed payloads carry no customer.id, so telegram/tag actions are refused.
    await expect(createAutomationRule(createInput({
      body: ruleDraft({
        triggerType: "payment.failed",
        conditions: [{ field: "payment.reason", operator: "eq", value: "card_declined" }],
        actions: [{ type: "rule_notify_telegram", config: { message: "Payment failed" } }],
      }),
    }))).rejects.toMatchObject({ code: "validation_failed", status: 400 });

    await expect(createAutomationRule(createInput({
      body: ruleDraft({
        triggerType: "payment.failed",
        conditions: [{ field: "payment.reason", operator: "eq", value: "card_declined" }],
        actions: [{ type: "rule_tag_customer", config: { tag: "failed" } }],
      }),
    }))).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("requires at least one action and rejects unknown action config fields", async () => {
    await expect(createAutomationRule(createInput({ body: ruleDraft({ actions: [] }) })))
      .rejects.toMatchObject({ code: "validation_failed", status: 400 });
    await expect(createAutomationRule(createInput({
      body: ruleDraft({ actions: [{ type: "rule_tag_customer", config: { tag: "vip", extra: true } }] }),
    }))).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("rejects conditions outside the trigger allow-list", async () => {
    await expect(createAutomationRule(createInput({
      body: ruleDraft({ conditions: [{ field: "payment.reason", operator: "eq", value: "x" }] }),
    }))).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });
});
