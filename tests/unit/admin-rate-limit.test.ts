import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardAdminMutationRate } from "../../src/lib/http/admin-rate-limit";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-08-17T02:00:30.000Z");

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]) {
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
    const results = this.database.prepare(this.sql).all(...this.values);
    return Promise.resolve({ results });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function bindings(database: DatabaseSync): AppBindings {
  const platformDb = {
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  };
  return {
    IDENTIFIER_HMAC_SECRET: "admin-rate-limit-test-secret",
    PLATFORM_DB: platformDb,
  } as unknown as AppBindings;
}

function requestFrom(ip: string | null): Request {
  const headers = new Headers();
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  return new Request("https://app.test/api/admin/appeals/prem_test", { headers, method: "POST" });
}

let database: DatabaseSync;
let env: AppBindings;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  applyMigrations(database);
  env = bindings(database);
});

afterEach(() => {
  database.close();
});

describe("admin mutation per-IP rate limiting", () => {
  it("admits requests inside the window budget and trips 429 once exceeded", async () => {
    const guard = (now: Date = NOW) => guardAdminMutationRate({
      env,
      family: "appeals",
      limit: 3,
      now,
      request: requestFrom("203.0.113.7"),
      windowSeconds: 60,
    });
    await expect(guard()).resolves.toBeUndefined();
    await expect(guard()).resolves.toBeUndefined();
    await expect(guard()).resolves.toBeUndefined();
    await expect(guard()).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await expect(guard()).rejects.toMatchObject({ code: "rate_limited", status: 429 });

    const row = database.prepare(`
      SELECT action, blocked_count, request_count, scope_key, shop_id, subject_hash
      FROM security_rate_limits
      WHERE scope_key = 'platform-admin:appeals'
    `).get() as {
      action: string;
      blocked_count: number;
      request_count: number;
      scope_key: string;
      shop_id: string | null;
      subject_hash: string;
    };
    expect(row.action).toBe("admin_mutation");
    expect(row.request_count).toBe(5);
    expect(row.blocked_count).toBe(2);
    expect(row.shop_id).toBeNull();
    expect(row.subject_hash.length).toBeGreaterThanOrEqual(16);
    expect(row.subject_hash).not.toContain("203.0.113.7");
  });

  it("tracks distinct client IPs and mutation families independently", async () => {
    const exhausted = (now: Date = NOW) => guardAdminMutationRate({
      env,
      family: "appeals",
      limit: 1,
      now,
      request: requestFrom("203.0.113.7"),
      windowSeconds: 60,
    });
    await expect(exhausted()).resolves.toBeUndefined();
    await expect(exhausted()).rejects.toMatchObject({ code: "rate_limited", status: 429 });

    await expect(guardAdminMutationRate({
      env,
      family: "appeals",
      limit: 1,
      now: NOW,
      request: requestFrom("198.51.100.9"),
      windowSeconds: 60,
    })).resolves.toBeUndefined();

    await expect(guardAdminMutationRate({
      env,
      family: "moderation",
      limit: 1,
      now: NOW,
      request: requestFrom("203.0.113.7"),
      windowSeconds: 60,
    })).resolves.toBeUndefined();
  });

  it("resets the budget when the fixed window rolls over", async () => {
    const guard = (now: Date) => guardAdminMutationRate({
      env,
      family: "operations_dead_letters",
      limit: 1,
      now,
      request: requestFrom("203.0.113.7"),
      windowSeconds: 60,
    });
    await expect(guard(NOW)).resolves.toBeUndefined();
    await expect(guard(NOW)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await expect(guard(new Date(NOW.getTime() + 61_000))).resolves.toBeUndefined();
  });

  it("rejects unknown families fail-closed instead of limiting the wrong bucket", async () => {
    await expect(guardAdminMutationRate({
      env,
      family: "not-a-family" as never,
      limit: 1,
      now: NOW,
      request: requestFrom("203.0.113.7"),
      windowSeconds: 60,
    })).rejects.toMatchObject({ code: "internal_error", status: 500 });
  });
});
