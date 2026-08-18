import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppError } from "../../src/lib/core/errors";
import {
  listAdminShopDirectory,
  parseAdminShopStatus,
  parseAdminSubscriptionState,
} from "../../src/lib/operations/admin-shop-directory";
import type { AppBindings } from "../../src/lib/platform/bindings";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    const sqlValues = values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    });
    return new SqliteStatement(this.database, this.sql, sqlValues);
  }

  first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values) as T | undefined;
    return Promise.resolve(row ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function bindings(database: DatabaseSync): AppBindings {
  return {
    PLATFORM_DB: {
      prepare(sql: string) {
        return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
      },
    },
  } as unknown as AppBindings;
}

function seed(database: DatabaseSync): void {
  // Keep the trial fixture valid regardless of the wall clock used by CI.
  const base = new Date("2099-07-29T00:00:00.000Z");
  const now = base.toISOString();
  database.prepare(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-safe', 'business', 'Business', '{}', '{}', ?, ?)
  `).run(now, now);

  const users: Array<[string, string, string]> = [
    ["admin-support", "admin-private@example.test", "Admin Private"],
    ["ordinary-user", "ordinary-private@example.test", "Ordinary Private"],
    ["owner-a", "owner-a-private@example.test", "Owner A Private"],
    ["owner-b", "owner-b-private@example.test", "Owner B Private"],
    ["owner-c", "owner-c-private@example.test", "Owner C Private"],
  ];
  for (const [id, email, displayName] of users) {
    database.prepare(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(id, email, displayName, now, now);
  }
  database.prepare(`
    INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
    VALUES ('admin-support', 'support', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = ?
    WHERE id = 'admin-support'
  `).run(now);

  const shops: Array<{
    id: string;
    name: string;
    owner: string | null;
    publicId: string;
    slug: string;
    state: "trialing" | "active" | "past_due" | "canceled";
    status: "draft" | "active" | "suspended" | "archived";
    updatedOffset: number;
  }> = [
    { id: "internal-shop-a", name: "Signal_100% Lab", owner: "owner-a", publicId: "shop_public_a", slug: "signal-lab", state: "active", status: "active", updatedOffset: 1 },
    { id: "internal-shop-b", name: "Canvas Store", owner: "owner-b", publicId: "shop_public_b", slug: "canvas", state: "past_due", status: "suspended", updatedOffset: 2 },
    { id: "internal-shop-c", name: "Orbit Shop", owner: "owner-c", publicId: "shop_public_c", slug: "orbit", state: "trialing", status: "draft", updatedOffset: 3 },
    { id: "internal-shop-d", name: "Archived Shop", owner: null, publicId: "shop_public_d", slug: "archived-shop", state: "canceled", status: "archived", updatedOffset: 4 },
  ];

  for (const shop of shops) {
    const updatedAt = new Date(base.getTime() + shop.updatedOffset * 60_000).toISOString();
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(shop.id, shop.publicId, shop.slug, shop.name, shop.status, now, updatedAt);
    if (shop.owner !== null) {
      database.prepare(`
        INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, 'owner', 'active', ?, ?)
      `).run(shop.id, shop.owner, now, updatedAt);
    }
    database.prepare(`
      INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at)
      VALUES (?, ?, 'plan-safe', ?, ?, ?, ?)
    `).run(`subscription-${shop.id}`, shop.id, shop.state, shop.state === "trialing" ? new Date(base.getTime() + 8 * 24 * 60 * 60_000).toISOString() : null, now, updatedAt);
  }

  database.prepare(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES ('product-signal', 'internal-shop-a', 'starter', 'Starter', '', 'active', 'manual', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO shop_channels (id, shop_id, channel_code, status, settings_json, created_at, updated_at)
    VALUES ('channel-signal', 'internal-shop-a', 'telegram', 'enabled', '{}', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO channel_connections (
      id, public_id, shop_id, shop_channel_id, provider_code, status,
      settings_json, created_at, updated_at
    ) VALUES ('connection-signal', 'connection_public_signal', 'internal-shop-a', 'channel-signal',
      'telegram', 'degraded', '{}', ?, ?)
  `).run(now, now);
}

describe("admin Sellers & Shops directory", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seed(database);
    env = bindings(database);
  });

  afterEach(() => {
    database.close();
  });

  it("requires an active platform-admin role", async () => {
    await expect(listAdminShopDirectory({
      env,
      filters: { cursor: null, query: null, shopStatus: null, subscriptionState: null },
      userId: "ordinary-user",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("returns only the safe shop projection and aggregate operational counts", async () => {
    const result = await listAdminShopDirectory({
      env,
      filters: { cursor: null, query: "Signal_100%", shopStatus: null, subscriptionState: null },
      userId: "admin-support",
    });

    expect(result.role).toBe("support");
    expect(result.shops).toEqual([expect.objectContaining({
      activeMemberCount: 1,
      activeOwnerCount: 1,
      activeProductCount: 1,
      degradedConnectionCount: 1,
      name: "Signal_100% Lab",
      openConnectionCount: 1,
      publicId: "shop_public_a",
      subscriptionState: "active",
    })]);
    const serialized = JSON.stringify(result.shops);
    expect(serialized).not.toContain("internal-shop-a");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toMatch(/email|displayName|ciphertext|credential|token|key_material|provider_payload/iu);
  });

  it("uses bounded status/subscription filters and an opaque cursor without duplicates", async () => {
    const first = await listAdminShopDirectory({
      env,
      filters: { cursor: null, limit: 2, query: null, shopStatus: null, subscriptionState: null },
      userId: "admin-support",
    });
    expect(first.shops.map((shop) => shop.publicId)).toEqual(["shop_public_d", "shop_public_c"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAdminShopDirectory({
      env,
      filters: { cursor: first.nextCursor, limit: 2, query: null, shopStatus: null, subscriptionState: null },
      userId: "admin-support",
    });
    expect(second.shops.map((shop) => shop.publicId)).toEqual(["shop_public_b", "shop_public_a"]);
    expect(second.nextCursor).toBeNull();

    const suspended = await listAdminShopDirectory({
      env,
      filters: { cursor: null, query: null, shopStatus: "suspended", subscriptionState: "past_due" },
      userId: "admin-support",
    });
    expect(suspended.shops.map((shop) => shop.publicId)).toEqual(["shop_public_b"]);
  });

  it("accepts and filters the pending_payment subscription state", async () => {
    // Regression: the directory used to reject this real DB state with 400
    // subscription_state_invalid, and the page crashed rendering such rows.
    const later = new Date("2099-07-29T01:00:00.000Z").toISOString();
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES ('internal-shop-pending', 'shop_public_pending', 'pending-shop', 'Pending Shop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(later, later);
    database.prepare(`
      INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at)
      VALUES ('subscription-pending', 'internal-shop-pending', 'plan-safe', 'pending_payment', NULL, ?, ?)
    `).run(later, later);

    expect(parseAdminSubscriptionState("pending_payment")).toBe("pending_payment");

    const filtered = await listAdminShopDirectory({
      env,
      filters: { cursor: null, query: null, shopStatus: null, subscriptionState: "pending_payment" },
      userId: "admin-support",
    });
    expect(filtered.shops.map((shop) => shop.publicId)).toEqual(["shop_public_pending"]);
    expect(filtered.shops[0]?.subscriptionState).toBe("pending_payment");

    const unfiltered = await listAdminShopDirectory({
      env,
      filters: { cursor: null, query: "Pending Shop", shopStatus: null, subscriptionState: null },
      userId: "admin-support",
    });
    expect(unfiltered.shops[0]?.subscriptionState).toBe("pending_payment");
  });

  it("fails closed on invalid filters, cursor and limit", async () => {
    expect(() => parseAdminShopStatus("compromised")).toThrow(expect.objectContaining<Partial<AppError>>({ code: "validation_failed" }));
    expect(() => parseAdminSubscriptionState("unknown")).toThrow(expect.objectContaining<Partial<AppError>>({ code: "validation_failed" }));
    await expect(listAdminShopDirectory({
      env,
      filters: { cursor: "not-a-cursor", query: null, shopStatus: null, subscriptionState: null },
      userId: "admin-support",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["cursor_invalid"] });
    await expect(listAdminShopDirectory({
      env,
      filters: { cursor: null, limit: 51, query: null, shopStatus: null, subscriptionState: null },
      userId: "admin-support",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["limit_invalid"] });
    await expect(listAdminShopDirectory({
      env,
      filters: { cursor: null, query: "x".repeat(65), shopStatus: null, subscriptionState: null },
      userId: "admin-support",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["query_invalid"] });
  });
});
