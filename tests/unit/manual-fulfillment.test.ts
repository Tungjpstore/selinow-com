import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  completeManualFulfillment,
  type ManualFulfillmentExecutionInput,
} from "../../src/lib/commerce/manual-fulfillment";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-07-30T03:00:00.000Z");
const SHOP_ID = "shop-manual-a";
const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-0000000000a1";
const ORDER_ID = "order-manual-a";
const ORDER_PUBLIC_ID = "order_00000000-0000-4000-8000-0000000000a1";
const ITEM_ID = "oit_00000000-0000-4000-8000-0000000000a1";
const SECOND_ITEM_ID = "oit_00000000-0000-4000-8000-0000000000a2";
const OWNER_ID = "user-manual-owner-a";

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

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private batchQueue = Promise.resolve();
  private nextBatchPause: { reached: () => void; released: Promise<void> } | null = null;

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  pauseNextBatch(): { reached: Promise<void>; resume: () => void } {
    let reachedResolve!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { reachedResolve = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.nextBatchPause = { reached: reachedResolve, released };
    return { reached, resume: release };
  }

  batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const pause = this.nextBatchPause;
    this.nextBatchPause = null;
    pause?.reached();
    const operation = this.batchQueue.then(async () => {
      if (pause !== null) await pause.released;
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
    });
    this.batchQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function seed(database: DatabaseSync): void {
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-manual', 'manual', 'Manual', '{}', '{}', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES
      ('${OWNER_ID}', 'owner-manual@example.test', 'Owner Manual', 'active', '${now}', '${now}'),
      ('user-manual-manager-a', 'manager-manual@example.test', 'Manager Manual', 'active', '${now}', '${now}'),
      ('user-manual-viewer-a', 'viewer-manual@example.test', 'Viewer Manual', 'active', '${now}', '${now}'),
      ('user-manual-owner-b', 'owner-manual-b@example.test', 'Owner Manual B', 'active', '${now}', '${now}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('${SHOP_ID}', '${SHOP_PUBLIC_ID}', 'manual-a', 'Manual A', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}'),
      ('shop-manual-b', 'shop_00000000-0000-4000-8000-0000000000b1', 'manual-b', 'Manual B', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES
      ('${SHOP_ID}', '${OWNER_ID}', 'owner', 'active', '${now}', '${now}'),
      ('${SHOP_ID}', 'user-manual-manager-a', 'manager', 'active', '${now}', '${now}'),
      ('${SHOP_ID}', 'user-manual-viewer-a', 'viewer', 'active', '${now}', '${now}'),
      ('shop-manual-b', 'user-manual-owner-b', 'owner', 'active', '${now}', '${now}');
    INSERT INTO shop_settings (shop_id, branding_json, storefront_json, order_expiry_minutes, low_stock_threshold, version, updated_at)
    VALUES
      ('${SHOP_ID}', '{}', '{}', 30, 5, 1, '${now}'),
      ('shop-manual-b', '{}', '{}', 30, 5, 1, '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_start, current_period_end, created_at, updated_at)
    VALUES
      ('subscription-manual-a', '${SHOP_ID}', 'plan-manual', 'active', '${now}', '2027-07-30T00:00:00.000Z', '${now}', '${now}'),
      ('subscription-manual-b', 'shop-manual-b', 'plan-manual', 'active', '${now}', '2027-07-30T00:00:00.000Z', '${now}', '${now}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES
      ('product-manual-a', '${SHOP_ID}', 'manual-product-a', 'Manual Product A', '', 'active', 'manual', 1, '${now}', '${now}'),
      ('product-manual-b', 'shop-manual-b', 'manual-product-b', 'Manual Product B', '', 'active', 'manual', 1, '${now}', '${now}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES
      ('variant-manual-a', '${SHOP_ID}', 'product-manual-a', 'MANUAL-A', 'Default', '{}', 1000, 'USD', 1, 5, 'active', 1, '${now}', '${now}'),
      ('variant-manual-b', 'shop-manual-b', 'product-manual-b', 'MANUAL-B', 'Default', '{}', 1000, 'USD', 1, 5, 'active', 1, '${now}', '${now}');
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES
      ('${ORDER_ID}', '${ORDER_PUBLIC_ID}', '${SHOP_ID}', 'MANUAL-A', 'web', 'processing', 'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-manual-a', 'token-manual-a', '2026-07-30T04:00:00.000Z', '${now}', '${now}', '${now}'),
      ('order-manual-b', 'order_00000000-0000-4000-8000-0000000000b1', 'shop-manual-b', 'MANUAL-B', 'web', 'processing', 'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-manual-b', 'token-manual-b', '2026-07-30T04:00:00.000Z', '${now}', '${now}', '${now}');
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES
      ('${ITEM_ID}', '${SHOP_ID}', '${ORDER_ID}', 'product-manual-a', 'variant-manual-a', 'Manual Product A', 'Default', 'MANUAL-A', 1000, 1, 1000, 'manual', '${now}'),
      ('oit_00000000-0000-4000-8000-0000000000b1', 'shop-manual-b', 'order-manual-b', 'product-manual-b', 'variant-manual-b', 'Manual Product B', 'Default', 'MANUAL-B', 1000, 1, 1000, 'manual', '${now}');
    INSERT INTO fulfillments (id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at)
    VALUES
      ('fulfillment-manual-a', '${SHOP_ID}', '${ORDER_ID}', 'manual', 'pending', 'payment:manual-a', '${now}'),
      ('fulfillment-manual-b', 'shop-manual-b', 'order-manual-b', 'manual', 'pending', 'payment:manual-b', '${now}');
  `);
}

function execution(orderItemId = ITEM_ID, reference = "DELIVERY-SECRET-001"): ManualFulfillmentExecutionInput {
  return {
    executionType: "seller_attested_delivery",
    externalReference: { reference, type: "delivery_reference" },
    orderItemId,
  };
}

describe("manual fulfillment execution", () => {
  let database: DatabaseSync;
  let d1: SqliteD1;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seed(database);
    d1 = new SqliteD1(database);
    env = {
      IDENTIFIER_HMAC_SECRET: "identifier-secret",
      PLATFORM_DB: d1 as unknown as D1Database,
      SESSION_SECRET: "session-secret",
    } as unknown as AppBindings;
  });

  afterEach(() => {
    database.close();
  });

  function complete(input: {
    idempotencyKey?: string;
    item?: ManualFulfillmentExecutionInput;
    orderPublicId?: string;
    shopPublicId?: string;
    userId?: string;
  } = {}) {
    return completeManualFulfillment({
      env,
      execution: input.item ?? execution(),
      idempotencyKey: input.idempotencyKey ?? "manual-completion-key-0001",
      orderPublicId: input.orderPublicId ?? ORDER_PUBLIC_ID,
      requestId: `request-${input.idempotencyKey ?? "manual-completion-key-0001"}`,
      runtime: { now: NOW },
      shopPublicId: input.shopPublicId ?? SHOP_PUBLIC_ID,
      userId: input.userId ?? OWNER_ID,
    });
  }

  it("stores a typed seller execution and only a keyed external-reference hash", async () => {
    const result = await complete();

    expect(result).toMatchObject({
      replayed: false,
      execution: {
        completedAt: NOW.toISOString(),
        completedQuantity: 1,
        evidence: { recorded: true, type: "delivery_reference" },
        executionType: "seller_attested_delivery",
        orderItemId: ITEM_ID,
        state: "completed",
      },
    });
    const reference = database.prepare(`
      SELECT reference_type AS referenceType, reference_hash AS referenceHash,
        hash_key_version AS hashKeyVersion
      FROM external_fulfillment_references WHERE shop_id = ?
    `).get(SHOP_ID) as Record<string, unknown>;
    expect(reference).toMatchObject({ referenceType: "delivery_reference", hashKeyVersion: "identifier-hmac-v1" });
    expect(reference.referenceHash).not.toBe("DELIVERY-SECRET-001");
    expect(JSON.stringify(database.prepare("SELECT * FROM external_fulfillment_references").all())).not.toContain("DELIVERY-SECRET-001");
    expect(JSON.stringify(database.prepare("SELECT safe_metadata_json FROM audit_logs WHERE action = 'manual_fulfillment.completed'").all())).not.toContain("DELIVERY-SECRET-001");
    expect(database.prepare("SELECT state FROM fulfillments WHERE id = 'fulfillment-manual-a'").get()).toEqual({ state: "fulfilled" });
    expect(database.prepare("SELECT status, fulfillment_status AS fulfillmentStatus FROM orders WHERE id = ?").get(ORDER_ID)).toEqual({ fulfillmentStatus: "fulfilled", status: "completed" });
  });

  it("replays the same command and conflicts when the request changes", async () => {
    const first = await complete();
    const replay = await complete();

    expect(replay).toEqual({ execution: first.execution, replayed: true });
    await expect(complete({ item: execution(ITEM_ID, "DIFFERENT-REFERENCE") }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_fulfillment_executions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM external_fulfillment_references").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'manual_fulfillment.completed'").get()).toEqual({ count: 1 });
  });

  it("keeps legacy fulfillment and order open until every manual item completes", async () => {
    database.prepare(`
      INSERT INTO order_items (
        id, shop_id, order_id, product_id, variant_id, product_title,
        variant_title, sku, unit_price_minor, quantity, line_total_minor,
        fulfillment_type, created_at
      ) VALUES (?, ?, ?, 'product-manual-a', 'variant-manual-a', 'Manual Product A 2',
        'Default', 'MANUAL-A-2', 1000, 2, 2000, 'manual', ?)
    `).run(SECOND_ITEM_ID, SHOP_ID, ORDER_ID, NOW.toISOString());
    database.prepare("UPDATE orders SET subtotal_minor = 3000, total_minor = 3000 WHERE id = ?").run(ORDER_ID);

    await complete();
    expect(database.prepare("SELECT state FROM fulfillments WHERE id = 'fulfillment-manual-a'").get()).toEqual({ state: "pending" });
    expect(database.prepare("SELECT status, fulfillment_status AS fulfillmentStatus FROM orders WHERE id = ?").get(ORDER_ID)).toEqual({ fulfillmentStatus: "unfulfilled", status: "processing" });

    const second = await complete({
      idempotencyKey: "manual-completion-key-0002",
      item: execution(SECOND_ITEM_ID, "DELIVERY-SECRET-002"),
    });
    expect(second.execution.completedQuantity).toBe(2);
    expect(database.prepare("SELECT state FROM fulfillments WHERE id = 'fulfillment-manual-a'").get()).toEqual({ state: "fulfilled" });
    expect(database.prepare("SELECT status, fulfillment_status AS fulfillmentStatus FROM orders WHERE id = ?").get(ORDER_ID)).toEqual({ fulfillmentStatus: "fulfilled", status: "completed" });
  });

  it("rejects unpaid, cross-order, cross-tenant and viewer execution attempts", async () => {
    database.prepare("UPDATE orders SET payment_status = 'pending', paid_at = NULL WHERE id = ?").run(ORDER_ID);
    await expect(complete()).rejects.toMatchObject({ code: "manual_fulfillment_not_ready", status: 409 });
    database.prepare("UPDATE orders SET payment_status = 'paid', paid_at = ? WHERE id = ?").run(NOW.toISOString(), ORDER_ID);

    await expect(complete({
      item: execution("oit_00000000-0000-4000-8000-0000000000b1"),
    })).rejects.toMatchObject({ code: "manual_fulfillment_item_not_found", status: 404 });
    await expect(complete({
      orderPublicId: "order_00000000-0000-4000-8000-0000000000b1",
    })).rejects.toMatchObject({ code: "manual_fulfillment_item_not_found", status: 404 });
    await expect(complete({ userId: "user-manual-viewer-a" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_fulfillment_executions").get()).toEqual({ count: 0 });
  });

  it("does not let the seller ledger reinterpret a private-file requirement as manual delivery", async () => {
    database.exec(`
      INSERT INTO digital_assets (
        id, shop_id, kind, status, created_by_user_id, created_at, updated_at
      ) VALUES ('asset-manual-private', '${SHOP_ID}', 'private_file', 'active', '${OWNER_ID}', '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO digital_asset_versions (
        id, shop_id, asset_id, version, object_key, filename_sanitized, content_type,
        byte_size, content_sha256, object_etag, status, created_by_user_id, created_at, updated_at
      ) VALUES ('version-manual-private', '${SHOP_ID}', 'asset-manual-private', 1,
        'private-digital-assets/shop-manual-a/version-manual-private', 'private.pdf',
        'application/pdf', 12, '${"c".repeat(43)}', 'etag-private', 'active', '${OWNER_ID}', '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO product_fulfillment_policies (
        id, shop_id, product_id, capability, policy_version, asset_version_id,
        max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('policy-manual-private', '${SHOP_ID}', 'product-manual-a', 'private_file', 1,
        'version-manual-private', 2, 600, NULL, 'active', '${OWNER_ID}', '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO order_item_fulfillment_requirements (
        id, shop_id, order_id, order_item_id, capability, policy_id, policy_version,
        asset_version_id, max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, created_at
      ) VALUES ('requirement-manual-private', '${SHOP_ID}', '${ORDER_ID}', '${ITEM_ID}',
        'private_file', 'policy-manual-private', 1, 'version-manual-private', 2, 600, NULL, '${NOW.toISOString()}');
    `);

    await expect(complete({ idempotencyKey: "manual-private-item-key-0001" }))
      .rejects.toMatchObject({ code: "manual_fulfillment_item_ineligible", status: 409 });
    expect(() => database.prepare(`
      INSERT INTO manual_fulfillment_executions (
        id, shop_id, order_id, order_item_id, fulfillment_id, execution_type,
        state, completed_quantity, actor_user_id, idempotency_key_hash,
        request_hash, request_id, completed_at, created_at
      ) VALUES ('mfx-private-bypass', ?, ?, ?, 'fulfillment-manual-a',
        'seller_attested_delivery', 'completed', 1, ?, ?, ?,
        'request-private-bypass', ?, ?)
    `).run(
      SHOP_ID,
      ORDER_ID,
      ITEM_ID,
      OWNER_ID,
      "p".repeat(43),
      "r".repeat(43),
      NOW.toISOString(),
      NOW.toISOString(),
    )).toThrow(/manual_fulfillment_execution_scope_mismatch/u);
    expect(database.prepare("SELECT state FROM fulfillments WHERE id = 'fulfillment-manual-a'").get()).toEqual({ state: "pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_fulfillment_executions").get()).toEqual({ count: 0 });
  });

  it("serializes concurrent different-key attempts so only one execution wins", async () => {
    const pause = d1.pauseNextBatch();
    const first = complete({ idempotencyKey: "manual-concurrency-key-0001" });
    await pause.reached;
    const second = complete({ idempotencyKey: "manual-concurrency-key-0002" });
    pause.resume();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: { code: "manual_fulfillment_already_completed", status: 409 } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_fulfillment_executions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'manual_fulfillment.completed'").get()).toEqual({ count: 1 });
  });

  it("enforces migration guards against direct unpaid, cross-tenant and unsupported-role writes", () => {
    const baseValues = [
      "mfx-direct-guard",
      SHOP_ID,
      ORDER_ID,
      ITEM_ID,
      "fulfillment-manual-a",
      OWNER_ID,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      NOW.toISOString(),
    ] as const;
    const statement = database.prepare(`
      INSERT INTO manual_fulfillment_executions (
        id, shop_id, order_id, order_item_id, fulfillment_id, execution_type,
        state, completed_quantity, actor_user_id, idempotency_key_hash,
        request_hash, request_id, completed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'seller_attested_delivery', 'completed', 1, ?, ?, ?,
        'request-direct-guard', ?, ?)
    `);

    database.prepare("UPDATE orders SET payment_status = 'pending', paid_at = NULL WHERE id = ?").run(ORDER_ID);
    expect(() => statement.run(...baseValues, NOW.toISOString())).toThrow(/manual_fulfillment_execution_scope_mismatch/u);
    database.prepare("UPDATE orders SET payment_status = 'paid', paid_at = ? WHERE id = ?").run(NOW.toISOString(), ORDER_ID);
    database.prepare("UPDATE shop_members SET role = 'viewer' WHERE shop_id = ? AND user_id = ?").run(SHOP_ID, OWNER_ID);
    expect(() => statement.run(...baseValues, NOW.toISOString())).toThrow(/manual_fulfillment_execution_scope_mismatch/u);
    database.prepare("UPDATE shop_members SET role = 'owner' WHERE shop_id = ? AND user_id = ?").run(SHOP_ID, OWNER_ID);
    expect(() => database.prepare(`
      INSERT INTO manual_fulfillment_executions (
        id, shop_id, order_id, order_item_id, fulfillment_id, execution_type,
        state, completed_quantity, actor_user_id, idempotency_key_hash,
        request_hash, request_id, completed_at, created_at
      ) VALUES ('mfx-cross-tenant', '${SHOP_ID}', 'order-manual-b',
        'oit_00000000-0000-4000-8000-0000000000b1', 'fulfillment-manual-b',
        'seller_attested_delivery', 'completed', 1, '${OWNER_ID}',
        'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
        'request-cross-tenant', '${NOW.toISOString()}', '${NOW.toISOString()}')
    `).run()).toThrow();
  });
});
