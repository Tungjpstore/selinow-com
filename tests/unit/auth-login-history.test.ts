import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hmacToken } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

const SECRET = "login-history-hmac-secret-123456";
const USER_ID = "usr-history";
const NOW = new Date("2026-08-15T12:00:00.000Z");

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    const sqlValues = values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    });
    return new SqliteStatement(this.database, this.sql, sqlValues);
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- D1 .all<T>() shape
  all<T>(): Promise<{ results: T[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) as T[] });
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
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

// Migrations stop at 0099 on purpose: login history belongs to the frozen M0
// baseline and must not depend on later migrations.
function applyMigrations(database: DatabaseSync, through = "0099"): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= through).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function seedUser(database: DatabaseSync): void {
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('${USER_ID}', 'history@example.com', 'History User', 'active', '${now}', '${now}');
  `);
}

function bindings(database: SqliteD1): AppBindings {
  return {
    APP_ENV: "local",
    IDENTIFIER_HMAC_SECRET: SECRET,
    LOG_LEVEL: "silent",
    PLATFORM_DB: database,
    SESSION_SECRET: "login-history-session-secret-123456",
  } as unknown as AppBindings;
}

describe("login history service", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seedUser(database);
    env = bindings(new SqliteD1(database));
  });

  afterEach(() => {
    database.close();
  });

  it("stores an HMAC digest of the requester address, never the raw IP", async () => {
    const { recordLoginHistory } = await import("../../src/lib/auth/login-history");
    await recordLoginHistory({ env, now: NOW, outcome: "success", requesterAddress: "203.0.113.9", userId: USER_ID });

    const rows = database.prepare("SELECT requester_hash, occurred_at FROM auth_login_history").all() as Array<{
      occurred_at: string;
      requester_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    const expected = await hmacToken(SECRET, "login-history-requester:v1", "203.0.113.9");
    expect(rows[0]?.requester_hash).toBe(expected);
    expect(rows[0]?.requester_hash).not.toBe("203.0.113.9");
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
    expect(rows[0]?.occurred_at).toBe(NOW.toISOString());
  });

  it("treats the ledger as immutable: UPDATE and DELETE are rejected by triggers", async () => {
    const { recordLoginHistory } = await import("../../src/lib/auth/login-history");
    await recordLoginHistory({ env, now: NOW, outcome: "success", requesterAddress: "203.0.113.9", userId: USER_ID });

    expect(() => {
      database.exec("UPDATE auth_login_history SET outcome = 'invalid_credentials'");
    }).toThrow("auth_login_history_immutable");
    expect(() => {
      database.exec("DELETE FROM auth_login_history");
    }).toThrow("auth_login_history_immutable");

    const remaining = database.prepare("SELECT outcome FROM auth_login_history").all() as Array<{ outcome: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.outcome).toBe("success");
  });

  it("lists entries newest-first and clamps the limit to 50", async () => {
    const { listLoginHistory, recordLoginHistory } = await import("../../src/lib/auth/login-history");
    for (let index = 0; index < 5; index += 1) {
      await recordLoginHistory({
        env,
        now: new Date(NOW.getTime() + index * 60_000),
        outcome: index % 2 === 0 ? "success" : "invalid_credentials",
        requesterAddress: `203.0.113.${String(index)}`,
        userId: USER_ID,
      });
    }

    const all = await listLoginHistory({ env, userId: USER_ID });
    expect(all).toHaveLength(5);
    expect(all[0]?.occurredAt).toBe(new Date(NOW.getTime() + 4 * 60_000).toISOString());

    const limited = await listLoginHistory({ env, limit: 2, userId: USER_ID });
    expect(limited).toHaveLength(2);

    const oversized = await listLoginHistory({ env, limit: 1000, userId: USER_ID });
    expect(oversized).toHaveLength(5);
  });

  it("defaults the limit to 20 for non-positive or non-integer values", async () => {
    const observed: number[] = [];
    const probeEnv = {
      ...env,
      PLATFORM_DB: {
        prepare: () => ({
          all: () => {
            return Promise.resolve({ results: [] });
          },
          bind: (...args: readonly unknown[]) => {
            observed.push(args[1] as number);
            return { all: () => Promise.resolve({ results: [] }) };
          },
        }),
      },
    } as unknown as AppBindings;

    const { listLoginHistory } = await import("../../src/lib/auth/login-history");
    await listLoginHistory({ env: probeEnv, limit: 0, userId: USER_ID });
    await listLoginHistory({ env: probeEnv, limit: -3, userId: USER_ID });
    await listLoginHistory({ env: probeEnv, limit: Number.NaN, userId: USER_ID });
    await listLoginHistory({ env: probeEnv, limit: 500, userId: USER_ID });

    expect(observed).toEqual([20, 20, 20, 50]);
  });

  it("never returns entries belonging to another user", async () => {
    const { listLoginHistory, recordLoginHistory } = await import("../../src/lib/auth/login-history");
    database.exec(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('usr-other', 'other@example.com', 'Other User', 'active', '${NOW.toISOString()}', '${NOW.toISOString()}');
    `);
    await recordLoginHistory({ env, now: NOW, outcome: "success", requesterAddress: "203.0.113.9", userId: USER_ID });
    await recordLoginHistory({ env, now: NOW, outcome: "invalid_credentials", requesterAddress: "203.0.113.9", userId: "usr-other" });

    const entries = await listLoginHistory({ env, userId: USER_ID });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("success");
  });

  it("swallows write failures so history never breaks authentication", async () => {
    const brokenEnv = {
      ...env,
      PLATFORM_DB: {
        prepare: () => {
          throw new Error("db_unavailable");
        },
      },
    } as unknown as AppBindings;

    const { recordLoginHistory } = await import("../../src/lib/auth/login-history");
    await expect(recordLoginHistory({
      env: brokenEnv,
      now: NOW,
      outcome: "success",
      requesterAddress: "203.0.113.9",
      userId: USER_ID,
    })).resolves.toBeUndefined();
  });
});

const routeDependencies = vi.hoisted(() => {
  const state: { env: Record<string, unknown>; requireCsrf: ReturnType<typeof vi.fn> } = {
    env: {},
    requireCsrf: vi.fn(),
  };
  return state;
});

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => routeDependencies.env,
}));

vi.mock("../../src/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  requireCsrfSession: routeDependencies.requireCsrf,
}));

import { GET as LoginHistoryGET } from "../../src/pages/api/app/account/login-history";

describe("GET /api/app/account/login-history route", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seedUser(database);
    routeDependencies.env = {
      APP_ENV: "local",
      IDENTIFIER_HMAC_SECRET: SECRET,
      LOG_LEVEL: "silent",
      PLATFORM_DB: new SqliteD1(database),
      SESSION_SECRET: "login-history-session-secret-123456",
    };
    routeDependencies.requireCsrf.mockReset();
    routeDependencies.requireCsrf.mockResolvedValue({
      authenticatedAt: "2026-08-15T11:55:00.000Z",
      csrfTokenHash: "csrf-hash",
      displayName: "History User",
      email: "history@example.com",
      sessionId: "ses-history",
      userId: USER_ID,
    });
  });

  afterEach(() => {
    database.close();
  });

  function context(query = "") {
    return {
      locals: { locale: "en-US", requestId: "request-login-history" },
      request: new Request(`https://app.example.test/api/app/account/login-history${query}`),
      url: new URL(`https://app.example.test/api/app/account/login-history${query}`),
    } as unknown as Parameters<typeof LoginHistoryGET>[0];
  }

  it("requires an authenticated session and returns private, no-store entries", async () => {
    const { recordLoginHistory } = await import("../../src/lib/auth/login-history");
    await recordLoginHistory({
      env: routeDependencies.env as unknown as AppBindings,
      now: NOW,
      outcome: "two_factor_required",
      requesterAddress: "203.0.113.9",
      userId: USER_ID,
    });

    const response = await LoginHistoryGET(context());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      entries: [{ outcome: "two_factor_required" }],
      ok: true,
      requestId: "request-login-history",
    });
    // Requester digests only — raw addresses never leave the server.
    expect(body).not.toContain("203.0.113.9");
  });

  it("rejects unauthenticated callers", async () => {
    const { AppError } = await import("../../src/lib/core/errors");
    routeDependencies.requireCsrf.mockRejectedValueOnce(new AppError("authentication_required", 401));

    const response = await LoginHistoryGET(context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "authentication_required" });
  });

  it("clamps an oversized limit query parameter", async () => {
    const { recordLoginHistory } = await import("../../src/lib/auth/login-history");
    for (let index = 0; index < 3; index += 1) {
      await recordLoginHistory({
        env: routeDependencies.env as unknown as AppBindings,
        now: new Date(NOW.getTime() + index * 60_000),
        outcome: "success",
        requesterAddress: "203.0.113.9",
        userId: USER_ID,
      });
    }

    const response = await LoginHistoryGET(context("?limit=9999"));
    expect(JSON.parse(await response.text())).toMatchObject({ entries: [{}, {}, {}] });

    const invalid = await LoginHistoryGET(context("?limit=abc"));
    expect(invalid.status).toBe(200);
    expect(JSON.parse(await invalid.text())).toMatchObject({ entries: [{}, {}, {}] });
  });
});
