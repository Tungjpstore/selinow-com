import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  backfillActivationMilestones,
  listActivationMilestones,
  processActivationMilestoneBackfill,
  purgeActivationMilestones,
  recordActivationMilestone,
  type ActivationProjection,
} from "../../src/lib/analytics/activation";
import type { AppBindings } from "../../src/lib/platform/bindings";

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
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE shops (id TEXT PRIMARY KEY NOT NULL, created_at TEXT) STRICT;");
  database.exec(readFileSync("migrations/0077_activation_milestone_ledger.sql", "utf8"));
  database.exec(`
    CREATE TABLE subscription_change_requests (
      id TEXT, shop_id TEXT, subscription_id TEXT, current_plan_id TEXT,
      requested_plan_id TEXT, action TEXT, expected_subscription_version INTEGER,
      reason_code TEXT, requested_by_user_id TEXT, reviewed_by_user_id TEXT,
      reviewed_at TEXT, provider_action_ref TEXT, provider_event_id TEXT,
      last_attempt_at TEXT, execution_attempts INTEGER, created_at TEXT,
      status TEXT, version INTEGER
    );
  `);
  database.exec(readFileSync("migrations/0079_phase1_completion_hardening.sql", "utf8"));
  database.prepare("INSERT INTO shops (id, created_at) VALUES (?, ?), (?, ?)").run("shp_a", "2026-01-01T00:00:00.000Z", "shp_b", "2026-01-01T00:00:00.000Z");
  return { database, env: { PLATFORM_DB: new SqliteD1(database) } as unknown as AppBindings };
}

function addBackfillTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE products (id TEXT, shop_id TEXT, status TEXT, fulfillment_type TEXT, created_at TEXT, updated_at TEXT, activated_at TEXT);
    CREATE TABLE product_variants (id TEXT, shop_id TEXT, product_id TEXT, status TEXT, created_at TEXT, updated_at TEXT, activated_at TEXT);
    CREATE TABLE inventory_batches (shop_id TEXT, variant_id TEXT, accepted_count INTEGER, created_at TEXT);
    CREATE TABLE payment_integrations (shop_id TEXT, provider TEXT, status TEXT, webhook_status TEXT, connected_at TEXT);
    CREATE TABLE telegram_integrations (shop_id TEXT, status TEXT, webhook_status TEXT, connected_at TEXT);
    CREATE TABLE shop_readiness_runs (shop_id TEXT, overall_status TEXT, trigger_kind TEXT, checked_at TEXT);
    CREATE TABLE shop_settings (shop_id TEXT, published_at TEXT);
    CREATE TABLE orders (shop_id TEXT, payment_status TEXT, fulfillment_status TEXT, created_at TEXT, fulfilled_at TEXT);
    CREATE TABLE subscription_events (shop_id TEXT, from_state TEXT, to_state TEXT, occurred_at TEXT);
  `);
}

describe("activation milestone ledger", () => {
  it("creates, replays, and rejects changed tenant-scoped payloads", async () => {
    const { database, env } = setup();
    const first = await recordActivationMilestone({
      env,
      idempotencyKey: "readiness_passed",
      milestone: "readiness_passed",
      projection: { trigger: "test" },
      reason: "passed",
      shopId: "shp_a",
      source: "readiness",
    });
    const replay = await recordActivationMilestone({
      env,
      idempotencyKey: "readiness_passed",
      milestone: "readiness_passed",
      projection: { trigger: "test" },
      reason: "passed",
      shopId: "shp_a",
      source: "readiness",
    });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(first.event.id);
    await expect(recordActivationMilestone({
      env,
      idempotencyKey: "readiness_passed",
      milestone: "readiness_passed",
      projection: { trigger: "publish" },
      reason: "passed",
      shopId: "shp_a",
      source: "readiness",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM activation_milestones").get()).toEqual({ count: 1 });
  });

  it("keeps reads and dedupe tenant-scoped and rejects PII-shaped projections", async () => {
    const { env } = setup();
    await recordActivationMilestone({
      env,
      idempotencyKey: "same-key",
      milestone: "shop_created",
      reason: "created",
      shopId: "shp_a",
      source: "shop",
    });
    const otherTenant = await recordActivationMilestone({
      env,
      idempotencyKey: "same-key",
      milestone: "shop_created",
      reason: "created",
      shopId: "shp_b",
      source: "shop",
    });
    expect(otherTenant.created).toBe(true);
    expect((await listActivationMilestones({ env, shopId: "shp_a" })).map((event) => event.shopId)).toEqual(["shp_a"]);
    await expect(recordActivationMilestone({
      env,
      idempotencyKey: "unsafe",
      milestone: "setup_started",
      projection: { email: "buyer@example.com" } as unknown as ActivationProjection,
      reason: "started",
      shopId: "shp_a",
      source: "onboarding",
    })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(recordActivationMilestone({
      env,
      idempotencyKey: "wrong-type",
      milestone: "setup_started",
      projection: { channel: true } as unknown as ActivationProjection,
      reason: "started",
      shopId: "shp_a",
      source: "onboarding",
    })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("purges only rows older than an explicit tenant cutoff", async () => {
    const { env } = setup();
    await recordActivationMilestone({
      env,
      idempotencyKey: "old",
      milestone: "setup_started",
      occurredAt: "2025-01-01T00:00:00.000Z",
      reason: "started",
      shopId: "shp_a",
      source: "onboarding",
    });
    await recordActivationMilestone({
      env,
      idempotencyKey: "new",
      milestone: "shop_created",
      occurredAt: "2026-01-01T00:00:00.000Z",
      reason: "created",
      shopId: "shp_b",
      source: "shop",
    });
    expect(await purgeActivationMilestones({ env, olderThan: "2025-06-01T00:00:00.000Z", shopId: "shp_a" })).toBe(1);
    expect((await listActivationMilestones({ env, shopId: "shp_a" })).length).toBe(0);
    expect((await listActivationMilestones({ env, shopId: "shp_b" })).length).toBe(1);
  });

  it("backfills all milestones from authoritative tenant state", async () => {
    const { database, env } = setup();
    addBackfillTables(database);
    const timestamp = "2026-01-01T00:00:00.000Z";
    database.exec(`
      INSERT INTO products VALUES ('prd_a', 'shp_a', 'active', 'license_key', '${timestamp}', '${timestamp}', '${timestamp}');
      INSERT INTO product_variants VALUES ('var_a', 'shp_a', 'prd_a', 'active', '${timestamp}', '${timestamp}', '${timestamp}');
      INSERT INTO inventory_batches VALUES ('shp_a', 'var_a', 1, '${timestamp}');
      INSERT INTO payment_integrations VALUES ('shp_a', 'payos', 'active', 'verified', '${timestamp}');
      INSERT INTO telegram_integrations VALUES ('shp_a', 'active', 'verified', '${timestamp}');
      INSERT INTO shop_readiness_runs VALUES ('shp_a', 'ready', 'manual', '${timestamp}');
      INSERT INTO shop_readiness_runs VALUES ('shp_a', 'ready', 'test', '${timestamp}');
      INSERT INTO shop_settings VALUES ('shp_a', '${timestamp}');
      INSERT INTO orders VALUES ('shp_a', 'paid', 'fulfilled', '${timestamp}', '${timestamp}');
      INSERT INTO subscription_events VALUES ('shp_a', 'trialing', 'active', '${timestamp}');
    `);
    const result = await backfillActivationMilestones({ env, now: timestamp, shopId: "shp_a" });
    expect(result).toEqual({ attempted: 12, created: 12 });
    expect((await listActivationMilestones({ env, shopId: "shp_a" })).map((event) => event.milestone)).toHaveLength(12);
    expect((await backfillActivationMilestones({ env, now: timestamp, shopId: "shp_a" })).created).toBe(0);
  });

  it("recovers inventory readiness for a manual-fulfillment seller", async () => {
    const { database, env } = setup();
    addBackfillTables(database);
    const timestamp = "2026-01-01T00:00:00.000Z";
    database.prepare("INSERT INTO products VALUES (?, ?, 'active', 'manual', ?, ?, ?)").run("prd_a", "shp_a", timestamp, timestamp, timestamp);
    database.prepare("INSERT INTO product_variants VALUES (?, ?, ?, 'active', ?, ?, ?)").run("var_a", "shp_a", "prd_a", timestamp, timestamp, timestamp);

    const result = await backfillActivationMilestones({ env, now: timestamp, shopId: "shp_a" });
    const events = await listActivationMilestones({ env, shopId: "shp_a" });

    expect(result).toEqual({ attempted: 4, created: 4 });
    expect(events.map((event) => event.milestone)).toContain("inventory_ready");
    expect((await listActivationMilestones({ env, shopId: "shp_b" })).length).toBe(0);
  });

  it("does not recover manual readiness without an active variant", async () => {
    const { database, env } = setup();
    addBackfillTables(database);
    const timestamp = "2026-01-01T00:00:00.000Z";
    database.prepare("INSERT INTO products VALUES (?, ?, 'active', 'manual', ?, ?, ?)").run("prd_a", "shp_a", timestamp, timestamp, timestamp);

    await backfillActivationMilestones({ env, now: timestamp, shopId: "shp_a" });

    expect((await listActivationMilestones({ env, shopId: "shp_a" })).map((event) => event.milestone)).not.toContain("inventory_ready");
  });

  it("uses the latest durable activation boundary for manual readiness", async () => {
    const { database, env } = setup();
    addBackfillTables(database);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const productActivatedAt = "2026-01-02T00:00:00.000Z";
    const variantActivatedAt = "2026-01-03T00:00:00.000Z";
    database.prepare("INSERT INTO products VALUES (?, ?, 'active', 'manual', ?, ?, ?)").run("prd_a", "shp_a", createdAt, productActivatedAt, productActivatedAt);
    database.prepare("INSERT INTO product_variants VALUES (?, ?, ?, 'active', ?, ?, ?)").run("var_a", "shp_a", "prd_a", createdAt, variantActivatedAt, variantActivatedAt);

    await backfillActivationMilestones({ env, now: variantActivatedAt, shopId: "shp_a" });
    const inventoryReady = (await listActivationMilestones({ env, shopId: "shp_a" }))
      .find((event) => event.milestone === "inventory_ready");

    expect(inventoryReady?.occurredAt).toBe(variantActivatedAt);
  });

  it("rotates scheduled backfill across every shop", async () => {
    const { database, env } = setup();
    addBackfillTables(database);
    const first = await processActivationMilestoneBackfill({ env, limit: 1, now: new Date("2026-01-02T00:00:00.000Z") });
    const second = await processActivationMilestoneBackfill({ env, limit: 1, now: new Date("2026-01-02T00:05:00.000Z") });
    expect(first).toMatchObject({ created: 2, failed: 0, shops: 1 });
    expect(second).toMatchObject({ created: 2, failed: 0, shops: 1 });
    expect(database.prepare("SELECT shop_id AS shopId, COUNT(*) AS count FROM activation_milestones GROUP BY shop_id ORDER BY shop_id").all()).toEqual([
      { count: 2, shopId: "shp_a" },
      { count: 2, shopId: "shp_b" },
    ]);
  });

  it("fails closed on context and timestamp changes", async () => {
    const { env } = setup();
    await expect(recordActivationMilestone({
      env,
      idempotencyKey: "bad-context",
      milestone: "product_created",
      reason: "ready",
      shopId: "shp_a",
      source: "inventory",
    })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(recordActivationMilestone({
      env,
      idempotencyKey: "bad-time",
      milestone: "shop_created",
      occurredAt: "2026-01-01T00:00:00Z",
      reason: "created",
      shopId: "shp_a",
      source: "shop",
    })).rejects.toMatchObject({ code: "validation_failed" });
  });
});
