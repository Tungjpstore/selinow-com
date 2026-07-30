import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { purgeExpiredSecurityRateLimits } from "../../src/lib/operations/security-rate-limit-maintenance";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function createRuntime(): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', 'shop-public-a', 'shop-a', 'Shop A', 'active', 'en', 'USD',
        'UTC', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'),
      ('shop-b', 'shop-public-b', 'shop-b', 'Shop B', 'active', 'en', 'USD',
        'UTC', 1, '${NOW.toISOString()}', '${NOW.toISOString()}');
  `);
  const platformDb = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            run() {
              const result = database.prepare(sql).run(...values as SQLInputValue[]);
              return Promise.resolve({ meta: { changes: Number(result.changes) } });
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, env: { PLATFORM_DB: platformDb } as AppBindings };
}

function insertLimit(database: DatabaseSync, input: {
  blockedUntil?: string | null;
  id: string;
  shopId: string;
  windowEndsAt: string;
}): void {
  database.prepare(`
    INSERT INTO security_rate_limits (
      id, shop_id, scope_key, action, subject_hash, window_started_at,
      window_ends_at, request_count, blocked_count, blocked_until,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, 'public_api_v1', ?, ?, ?, 1, 0, ?, 1, ?, ?)
  `).run(
    input.id,
    input.shopId,
    `api-credential:${input.id}`,
    `secret-digest-${input.id}`,
    "2026-07-29T10:00:00.000Z",
    input.windowEndsAt,
    input.blockedUntil ?? null,
    "2026-07-29T10:00:00.000Z",
    "2026-07-29T10:00:00.000Z",
  );
}

describe("security rate-limit retention", () => {
  it("adds the expiry index and purges no more than the hard maximum", async () => {
    const { database, env } = createRuntime();
    expect(database.prepare("PRAGMA index_info('idx_security_rate_limits_expiry')").all()
      .map((column) => column.name)).toEqual([
      "window_ends_at",
      "shop_id",
      "id",
      "blocked_until",
    ]);
    expect(database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM security_rate_limits
      WHERE window_ends_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?)
      ORDER BY window_ends_at, shop_id, id LIMIT ?
    `).all(NOW.toISOString(), NOW.toISOString(), 500)
      .some((step) => String(step.detail).includes("idx_security_rate_limits_expiry")))
      .toBe(true);

    for (let index = 0; index < 1_005; index += 1) {
      insertLimit(database, {
        id: `limit-expired-${String(index).padStart(4, "0")}`,
        shopId: index % 2 === 0 ? "shop-a" : "shop-b",
        windowEndsAt: "2026-07-29T11:00:00.000Z",
      });
    }
    insertLimit(database, {
      id: "limit-active-window",
      shopId: "shop-a",
      windowEndsAt: "2026-07-29T13:00:00.000Z",
    });
    insertLimit(database, {
      blockedUntil: "2026-07-29T12:30:00.000Z",
      id: "limit-active-block",
      shopId: "shop-b",
      windowEndsAt: "2026-07-29T11:00:00.000Z",
    });

    await expect(purgeExpiredSecurityRateLimits(env, NOW, 10_000)).resolves.toBe(1_000);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM security_rate_limits
      WHERE id LIKE 'limit-expired-%'
    `).get()).toEqual({ count: 5 });
    expect(database.prepare(`
      SELECT id, shop_id AS shopId FROM security_rate_limits
      WHERE id IN ('limit-active-window', 'limit-active-block') ORDER BY id
    `).all()).toEqual([
      { id: "limit-active-block", shopId: "shop-b" },
      { id: "limit-active-window", shopId: "shop-a" },
    ]);
  });

  it("uses the bounded default for invalid limits without returning identifiers", async () => {
    const { database, env } = createRuntime();
    for (let index = 0; index < 501; index += 1) {
      insertLimit(database, {
        id: `limit-default-${String(index).padStart(4, "0")}`,
        shopId: "shop-a",
        windowEndsAt: "2026-07-29T11:00:00.000Z",
      });
    }

    const result = await purgeExpiredSecurityRateLimits(env, NOW, 0);
    expect(result).toBe(500);
    expect(typeof result).toBe("number");
    expect(database.prepare("SELECT COUNT(*) AS count FROM security_rate_limits").get())
      .toEqual({ count: 1 });
  });
});
