import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import {
  describePlatformAdminAccess,
  getPlatformAdminRole,
  isPlatformAdmin,
  requirePlatformAdminApiAccess,
} from "../../src/lib/tenants/store";

const NOW = new Date("2026-08-17T02:00:00.000Z");

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
  return { PLATFORM_DB: platformDb } as unknown as AppBindings;
}

let database: DatabaseSync;
let env: AppBindings;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  applyMigrations(database);
  env = bindings(database);
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES
      ('admin-enrolled', 'enrolled@example.test', 'Enrolled Admin', 'active', '${now}', '${now}'),
      ('admin-unenrolled', 'unenrolled@example.test', 'Unenrolled Admin', 'active', '${now}', '${now}'),
      ('admin-suspended', 'suspended@example.test', 'Suspended Admin', 'active', '${now}', '${now}'),
      ('ordinary-user', 'ordinary@example.test', 'Ordinary User', 'active', '${now}', '${now}');
    UPDATE platform_users
    SET two_factor_enabled = 1, two_factor_enabled_at = '${now}'
    WHERE id = 'admin-enrolled';
    INSERT INTO platform_admins (user_id, role, status, created_at, updated_at) VALUES
      ('admin-enrolled', 'owner', 'active', '${now}', '${now}'),
      ('admin-unenrolled', 'risk', 'active', '${now}', '${now}'),
      ('admin-suspended', 'support', 'suspended', '${now}', '${now}');
  `);
});

afterEach(() => {
  database.close();
});

describe("mandatory platform-admin two-factor enforcement", () => {
  it("denies an admin without confirmed 2FA and surfaces the enrollment code", async () => {
    expect(await getPlatformAdminRole({ env, userId: "admin-unenrolled" })).toBeNull();
    expect(await isPlatformAdmin({ env, userId: "admin-unenrolled" })).toBe(false);
    expect(await describePlatformAdminAccess({ env, userId: "admin-unenrolled" }))
      .toEqual({ kind: "two_factor_required" });
    await expect(requirePlatformAdminApiAccess({ env, userId: "admin-unenrolled" }))
      .rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });
  });

  it("allows an enrolled admin through every guard unchanged", async () => {
    expect(await getPlatformAdminRole({ env, userId: "admin-enrolled" })).toBe("owner");
    expect(await isPlatformAdmin({ env, userId: "admin-enrolled" })).toBe(true);
    expect(await describePlatformAdminAccess({ env, userId: "admin-enrolled" }))
      .toEqual({ kind: "authorized", role: "owner" });
    await expect(requirePlatformAdminApiAccess({ env, userId: "admin-enrolled" }))
      .resolves.toBe("owner");
  });

  it("keeps enrolling 2FA for a previously denied admin fail-closed until confirmed", async () => {
    await expect(requirePlatformAdminApiAccess({ env, userId: "admin-unenrolled" }))
      .rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });
    database.prepare(`
      UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = ?
      WHERE id = 'admin-unenrolled'
    `).run(NOW.toISOString());
    await expect(requirePlatformAdminApiAccess({ env, userId: "admin-unenrolled" }))
      .resolves.toBe("risk");
  });

  it("leaves non-admin users unchanged with authorization_denied", async () => {
    expect(await getPlatformAdminRole({ env, userId: "ordinary-user" })).toBeNull();
    expect(await isPlatformAdmin({ env, userId: "ordinary-user" })).toBe(false);
    expect(await describePlatformAdminAccess({ env, userId: "ordinary-user" }))
      .toEqual({ kind: "not_admin" });
    await expect(requirePlatformAdminApiAccess({ env, userId: "ordinary-user" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("denies suspended admins even with confirmed 2FA", async () => {
    database.prepare(`
      UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = ?
      WHERE id = 'admin-suspended'
    `).run(NOW.toISOString());
    expect(await getPlatformAdminRole({ env, userId: "admin-suspended" })).toBeNull();
    await expect(requirePlatformAdminApiAccess({ env, userId: "admin-suspended" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("fails closed when an admin row has no matching platform user", async () => {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
      VALUES ('ghost-admin', 'owner', 'active', '${NOW.toISOString()}', '${NOW.toISOString()}');
      PRAGMA foreign_keys = ON;
    `);
    expect(await getPlatformAdminRole({ env, userId: "ghost-admin" })).toBeNull();
    expect(await describePlatformAdminAccess({ env, userId: "ghost-admin" }))
      .toEqual({ kind: "not_admin" });
  });
});
