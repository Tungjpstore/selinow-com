import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createOperatorEncryptionRotation,
  listEncryptionRotationRuns,
  parseRotationKeyFamily,
  processOperatorEncryptionRotation,
} from "../../src/lib/operations/rotation-operator";
import type { AppBindings } from "../../src/lib/platform/bindings";

const KEK_V1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEK_V2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const NOW = "2026-07-26T03:00:00.000Z";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }));
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

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function bindings(database: DatabaseSync): AppBindings {
  const platformDb = {
    async batch(statements: D1PreparedStatement[]) {
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
    },
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  };
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v2",
    ACTIVE_INVENTORY_KEY_VERSION: "v2",
    CREDENTIAL_KEK_V1: KEK_V1,
    CREDENTIAL_KEK_V2: KEK_V2,
    INVENTORY_KEK_V1: KEK_V1,
    INVENTORY_KEK_V2: KEK_V2,
    PLATFORM_DB: platformDb,
    SESSION_SECRET: "rotation-operator-session-secret",
  } as unknown as AppBindings;
}

function seed(database: DatabaseSync): void {
  for (const [id, role] of [["admin-owner", "owner"], ["admin-risk", "risk"]] as const) {
    database.prepare(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(id, `${id}@example.test`, id, NOW, NOW);
    database.prepare(`
      INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `).run(id, role, NOW, NOW);
    database.prepare(`
      UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = ?
      WHERE id = ?
    `).run(NOW, id);
  }
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES ('shop-internal-a', 'shop_public_a', 'shop-a', 'Shop A', 'active',
      'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(NOW, NOW);
}

describe("encryption rotation operator surface", () => {
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

  it("creates a shop-scoped dry-run idempotently without exposing internal tenant IDs", async () => {
    const input = {
      actorUserId: "admin-owner",
      dryRun: true,
      env,
      globalConfirmation: null,
      idempotencyKey: "rotation-create-0001",
      keyFamily: "inventory" as const,
      liveConfirmation: null,
      requestId: "request-rotation-create",
      scope: "shop" as const,
      shopPublicId: "shop_public_a",
      sourceKeyVersion: "v1",
      targetKeyVersion: "v2",
    };
    const first = await createOperatorEncryptionRotation(input);
    const replay = await createOperatorEncryptionRotation({ ...input, requestId: "request-retry" });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ completed: true, oldVersionRows: 0, status: "completed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM encryption_rotation_runs").get()).toEqual({ count: 1 });
    const overview = await listEncryptionRotationRuns({ env, userId: "admin-risk" });
    expect(overview.canOperate).toBe(false);
    expect(overview.runs[0]).toMatchObject({ scope: "shop", shopPublicId: "shop_public_a" });
    expect(JSON.stringify(overview)).not.toContain("shop-internal-a");
  });

  it("requires owner role and explicit global/live confirmations", async () => {
    const base = {
      actorUserId: "admin-owner",
      dryRun: false,
      env,
      globalConfirmation: "ROTATE_GLOBAL",
      idempotencyKey: "rotation-create-0002",
      keyFamily: "inventory" as const,
      liveConfirmation: "ROTATE_LIVE",
      requestId: "request-rotation-guard",
      scope: "global" as const,
      shopPublicId: null,
      sourceKeyVersion: "v1",
      targetKeyVersion: "v2",
    };
    await expect(createOperatorEncryptionRotation({ ...base, actorUserId: "admin-risk" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(createOperatorEncryptionRotation({ ...base, globalConfirmation: null }))
      .rejects.toMatchObject({ code: "rotation_confirmation_required", status: 400 });
    await expect(createOperatorEncryptionRotation({ ...base, liveConfirmation: null }))
      .rejects.toMatchObject({ code: "rotation_confirmation_required", status: 400 });
  });

  it("denies an un-enrolled owner on rotation creation until two-factor enrollment completes", async () => {
    // The suite seeders enroll 2FA for the standing admins, so the un-enrolled
    // active owner fixture must be created explicitly for this guard test.
    database.prepare(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('admin-unenrolled-owner', 'unenrolled-owner@example.test', 'admin-unenrolled-owner', 'active', ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
      VALUES ('admin-unenrolled-owner', 'owner', 'active', ?, ?)
    `).run(NOW, NOW);
    const input = {
      actorUserId: "admin-unenrolled-owner",
      dryRun: true,
      env,
      globalConfirmation: null,
      idempotencyKey: "rotation-unenrolled-0001",
      keyFamily: "inventory" as const,
      liveConfirmation: null,
      requestId: "request-rotation-unenrolled",
      scope: "shop" as const,
      shopPublicId: "shop_public_a",
      sourceKeyVersion: "v1",
      targetKeyVersion: "v2",
    };

    await expect(createOperatorEncryptionRotation(input))
      .rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM encryption_rotation_runs").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get()).toEqual({ count: 0 });

    database.prepare(`
      UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = ?
      WHERE id = 'admin-unenrolled-owner'
    `).run(NOW);
    const created = await createOperatorEncryptionRotation(input);
    expect(created).toMatchObject({ completed: true, status: "completed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM encryption_rotation_runs").get()).toEqual({ count: 1 });
  });

  it("accepts explicit generated-license rotation families at the operator boundary", () => {
    expect(parseRotationKeyFamily("generated_license_credentials")).toBe("generated_license_credentials");
    expect(parseRotationKeyFamily("generated_license_artifacts")).toBe("generated_license_artifacts");
  });

  it("processes a live run in a bounded idempotent batch", async () => {
    const created = await createOperatorEncryptionRotation({
      actorUserId: "admin-owner",
      dryRun: false,
      env,
      globalConfirmation: null,
      idempotencyKey: "rotation-create-0003",
      keyFamily: "inventory",
      liveConfirmation: "ROTATE_LIVE",
      requestId: "request-live-create",
      scope: "shop",
      shopPublicId: "shop_public_a",
      sourceKeyVersion: "v1",
      targetKeyVersion: "v2",
    });
    const processInput = {
      actorUserId: "admin-owner",
      env,
      idempotencyKey: "rotation-process-0001",
      limit: 25,
      requestId: "request-live-process",
      runId: created.runId,
    };
    const first = await processOperatorEncryptionRotation(processInput);
    const replay = await processOperatorEncryptionRotation({ ...processInput, requestId: "request-process-retry" });

    expect(first).toMatchObject({ completed: true, status: "completed" });
    expect(replay).toEqual(first);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM idempotency_records
      WHERE actor_user_id = 'admin-owner'
    `).get()).toEqual({ count: 2 });
  });
});
