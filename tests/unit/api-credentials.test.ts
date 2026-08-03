import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  authenticatePublicApiRequest,
  issueApiCredential,
  listApiCredentials,
  revokeApiCredential,
} from "../../src/lib/api/credentials";
import { buildStandardExportPayload } from "../../src/lib/operations/exports";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-07-29T06:00:00.000Z");
const SHOP_A_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const SHOP_B_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000002";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
    private readonly beforeRun?: (database: DatabaseSync, sql: string) => void,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[], this.beforeRun);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({
      results: this.database.prepare(this.sql).all(...this.values),
    });
  }

  run(): Promise<{ meta: { changes: number } }> {
    this.beforeRun?.(this.database, this.sql);
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  constructor(
    readonly database: DatabaseSync,
    private readonly beforeRun?: (database: DatabaseSync, sql: string) => void,
  ) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, [], this.beforeRun);
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
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
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createRuntime(
  beforeRun?: (database: DatabaseSync, sql: string) => void,
): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO plans (
      id, code, name, feature_flags_json, limits_json, created_at, updated_at
    ) VALUES ('plan-api', 'business', 'Business', '{}', '{}', '${now}', '${now}');
    INSERT INTO platform_users (
      id, email_normalized, display_name, status, created_at, updated_at
    ) VALUES
      ('user-owner-a', 'owner-a@example.test', 'Owner A', 'active', '${now}', '${now}'),
      ('user-owner-a2', 'owner-a2@example.test', 'Owner A2', 'active', '${now}', '${now}'),
      ('user-owner-b', 'owner-b@example.test', 'Owner B', 'active', '${now}', '${now}'),
      ('user-manager-a', 'manager-a@example.test', 'Manager A', 'active', '${now}', '${now}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', '${SHOP_A_PUBLIC_ID}', 'api-a', 'API Shop A', 'active',
        'vi-VN', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}'),
      ('shop-b', '${SHOP_B_PUBLIC_ID}', 'api-b', 'API Shop B', 'active',
        'en-US', 'USD', 'America/New_York', 1, '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES
      ('shop-a', 'user-owner-a', 'owner', 'active', '${now}', '${now}'),
      ('shop-a', 'user-owner-a2', 'owner', 'active', '${now}', '${now}'),
      ('shop-b', 'user-owner-b', 'owner', 'active', '${now}', '${now}'),
      ('shop-a', 'user-manager-a', 'manager', 'active', '${now}', '${now}');
    INSERT INTO shop_subscriptions (
      id, shop_id, plan_id, state, created_at, updated_at
    ) VALUES
      ('subscription-a', 'shop-a', 'plan-api', 'active', '${now}', '${now}'),
      ('subscription-b', 'shop-b', 'plan-api', 'active', '${now}', '${now}');
    INSERT INTO shop_settings (
      shop_id, branding_json, storefront_json, order_expiry_minutes,
      low_stock_threshold, version, updated_at
    ) VALUES
      ('shop-a', '{}', '{}', 30, 5, 1, '${now}'),
      ('shop-b', '{}', '{}', 30, 5, 1, '${now}');
  `);
  const d1 = new SqliteD1(database, beforeRun);
  return {
    database,
    env: {
      APP_ENV: "local",
      IDENTIFIER_HMAC_SECRET: "api-credential-identifier-secret",
      PLATFORM_DB: d1 as unknown as D1Database,
      SESSION_SECRET: "api-credential-session-secret",
    } as AppBindings,
  };
}

async function issue(env: AppBindings, input: {
  idempotencyKey?: string;
  name?: string;
  shopPublicId?: string;
  userId?: string;
} = {}) {
  return issueApiCredential({
    env,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    idempotencyKey: input.idempotencyKey ?? "api-credential-create-001",
    name: input.name ?? "Warehouse sync",
    now: NOW,
    requestId: "request-api-credential-issue",
    scopes: ["shop:read"],
    shopPublicId: input.shopPublicId ?? SHOP_A_PUBLIC_ID,
    userId: input.userId ?? "user-owner-a",
  });
}

describe("API credential migration", () => {
  it("creates a retained tenant credential schema with immutable identity and active-member guards", () => {
    const { database } = createRuntime();
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN (
        'api_credentials', 'idx_api_credentials_shop_status',
        'api_credentials_identity_immutable', 'api_credentials_transition_guard',
        'api_credentials_no_delete'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "api_credentials" },
      { name: "api_credentials_identity_immutable" },
      { name: "api_credentials_no_delete" },
      { name: "api_credentials_transition_guard" },
      { name: "idx_api_credentials_shop_status" },
    ]);

    const insert = database.prepare(`
      INSERT INTO api_credentials (
        id, public_id, shop_id, name, scope_json, token_hash, status,
        created_by_user_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?)
    `);
    insert.run(
      "api-credential-a",
      "akc_00000000-0000-4000-8000-000000000010",
      "shop-a",
      "Primary API key",
      '["shop:read"]',
      "a".repeat(43),
      "user-owner-a",
      NOW.toISOString(),
      NOW.toISOString(),
    );
    expect(() => insert.run(
      "api-credential-cross",
      "akc_00000000-0000-4000-8000-000000000011",
      "shop-b",
      "Cross tenant key",
      '["shop:read"]',
      "b".repeat(43),
      "user-owner-a",
      NOW.toISOString(),
      NOW.toISOString(),
    )).toThrow(/api_credential_actor_not_tenant_member/u);
    expect(() => database.prepare(`
      UPDATE api_credentials SET public_id = ?, version = version + 1
      WHERE id = 'api-credential-a'
    `).run("akc_00000000-0000-4000-8000-000000000099")).toThrow(/api_credential_(?:identity_immutable|transition_invalid)/u);
    expect(() => database.prepare(`
      UPDATE api_credentials SET scope_json = '["shop:read","orders:read"]'
      WHERE id = 'api-credential-a'
    `).run()).toThrow();
    expect(() => database.prepare(`
      UPDATE api_credentials SET expires_at = '2027-01-01T00:00:00.000Z'
      WHERE id = 'api-credential-a'
    `).run()).toThrow();
    expect(() => database.prepare("DELETE FROM api_credentials WHERE id = 'api-credential-a'").run())
      .toThrow(/api_credential_immutable/u);
    expect(() => database.prepare("DELETE FROM shops WHERE id = 'shop-a'").run()).toThrow();
  });

  it("widens the immutable scope allowlist while preserving legacy rows and guards", () => {
    const { database } = createRuntime();
    const insert = database.prepare(`
      INSERT INTO api_credentials (
        id, public_id, shop_id, name, scope_json, token_hash, status,
        created_by_user_id, version, created_at, updated_at
      ) VALUES (?, ?, 'shop-a', ?, ?, ?, 'active', 'user-owner-a', 1, ?, ?)
    `);
    const now = NOW.toISOString();
    insert.run(
      "api-credential-catalog",
      "akc_00000000-0000-4000-8000-000000000040",
      "Catalog key",
      '["catalog:read"]',
      "c".repeat(43),
      now,
      now,
    );
    insert.run(
      "api-credential-combined",
      "akc_00000000-0000-4000-8000-000000000041",
      "Combined key",
      '["catalog:read","shop:read"]',
      "d".repeat(43),
      now,
      now,
    );
    expect(database.prepare("SELECT scope_json AS scopeJson FROM api_credentials ORDER BY id").all()).toEqual([
      { scopeJson: '["catalog:read"]' },
      { scopeJson: '["catalog:read","shop:read"]' },
    ]);
    expect(() => insert.run(
      "api-credential-invalid-scope",
      "akc_00000000-0000-4000-8000-000000000042",
      "Invalid key",
      '["unknown:read"]',
      "e".repeat(43),
      now,
      now,
    )).toThrow();
    expect(() => database.prepare(`
      UPDATE api_credentials SET scope_json = '["shop:read"]'
      WHERE id = 'api-credential-catalog'
    `).run()).toThrow(/api_credential_identity_immutable/u);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN (
        'idx_api_credentials_shop_status', 'idx_api_credentials_shop_expires',
        'api_credentials_require_active_member_insert', 'api_credentials_active_limit_insert',
        'api_credentials_identity_immutable', 'api_credentials_transition_guard',
        'api_credentials_no_delete'
      ) ORDER BY name
    `).all()).toHaveLength(7);
  });

  it("enforces the ten-active-credential tenant limit in the database", () => {
    const { database } = createRuntime();
    const insert = database.prepare(`
      INSERT INTO api_credentials (
        id, public_id, shop_id, name, scope_json, token_hash, status,
        created_by_user_id, version, created_at, updated_at
      ) VALUES (?, ?, 'shop-a', 'Key', '["shop:read"]', ?, 'active',
        'user-owner-a', 1, ?, ?)
    `);
    for (let index = 0; index < 10; index += 1) {
      const suffix = String(index).padStart(12, "0");
      insert.run(
        `credential-${String(index)}`,
        `akc_00000000-0000-4000-8000-${suffix}`,
        String(index).repeat(43).slice(0, 43),
        NOW.toISOString(),
        NOW.toISOString(),
      );
    }
    expect(() => insert.run(
      "credential-11",
      "akc_00000000-0000-4000-8000-000000000011",
      "z".repeat(43),
      NOW.toISOString(),
      NOW.toISOString(),
    )).toThrow(/api_credential_active_limit_reached/u);
  });

  it("does not count already expired active rows against the issuance limit", () => {
    const { database } = createRuntime();
    const insert = database.prepare(`
      INSERT INTO api_credentials (
        id, public_id, shop_id, name, scope_json, token_hash, status,
        expires_at, created_by_user_id, version, created_at, updated_at
      ) VALUES (?, ?, 'shop-a', 'Expired key', '["shop:read"]', ?, 'active', ?,
        'user-owner-a', 1, ?, ?)
    `);
    const createdAt = "2025-12-01T00:00:00.000Z";
    const expiredAt = "2026-01-01T00:00:00.000Z";
    for (let index = 0; index < 10; index += 1) {
      const suffix = String(index).padStart(12, "0");
      insert.run(
        `expired-credential-${String(index)}`,
        `akc_10000000-0000-4000-8000-${suffix}`,
        `e${String(index)}`.padEnd(43, "e"),
        expiredAt,
        createdAt,
        createdAt,
      );
    }
    expect(() => database.prepare(`
      INSERT INTO api_credentials (
        id, public_id, shop_id, name, scope_json, token_hash, status,
        created_by_user_id, version, created_at, updated_at
      ) VALUES (
        'fresh-credential', 'akc_20000000-0000-4000-8000-000000000001',
        'shop-a', 'Fresh key', '["shop:read"]', ?, 'active',
        'user-owner-a', 1, ?, ?
      )
    `).run("f".repeat(43), NOW.toISOString(), NOW.toISOString())).not.toThrow();
  });
});

describe("API credential lifecycle", () => {
  it("reveals the high-entropy token once and replays only redacted metadata", async () => {
    const { database, env } = createRuntime();
    const first = await issue(env);
    expect(first.replayed).toBe(false);
    expect(first.tokenAvailable).toBe(true);
    expect(first.token).toMatch(/^sln_local_akc_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
    expect(first.credential).toMatchObject({ name: "Warehouse sync", scopes: ["shop:read"], status: "active", version: 1 });

    const serializedDatabase = JSON.stringify(database.prepare(`
      SELECT token_hash AS tokenHash, scope_json AS scopeJson
      FROM api_credentials WHERE public_id = ?
    `).get(first.credential.publicId));
    expect(serializedDatabase).not.toContain(first.token as string);
    const idempotency = database.prepare(`
      SELECT response_json AS responseJson FROM idempotency_records
      WHERE actor_user_id = 'user-owner-a' AND namespace = 'api-credential.create.v1:shop-a'
    `).get() as { responseJson: string };
    expect(idempotency.responseJson).not.toContain(first.token as string);
    const tokenHash = (database.prepare(`
      SELECT token_hash AS tokenHash FROM api_credentials WHERE public_id = ?
    `).get(first.credential.publicId) as { tokenHash: string }).tokenHash;
    const exported = await buildStandardExportPayload({
      env,
      exportedAt: NOW.toISOString(),
      shop: {
        publicId: SHOP_A_PUBLIC_ID,
        role: "owner",
        shopId: "shop-a",
        slug: "api-a",
        status: "active",
      },
    });
    expect(exported).toMatchObject({
      data: {
        apiCredentials: [{
          expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
          name: "Warehouse sync",
          publicId: first.credential.publicId,
          scopes: ["shop:read"],
          status: "active",
          version: 1,
        }],
      },
    });
    expect(JSON.stringify(exported)).not.toContain(first.token as string);
    expect(JSON.stringify(exported)).not.toContain(tokenHash);

    const replay = await issue(env);
    expect(replay).toMatchObject({ replayed: true, token: null, tokenAvailable: false });
    expect(replay.credential.publicId).toBe(first.credential.publicId);
    expect(await listApiCredentials({ env, shopPublicId: SHOP_A_PUBLIC_ID, userId: "user-owner-a" }))
      .toHaveLength(1);
    await expect(issue(env, { name: "Changed payload" })).rejects
      .toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(issue(env, { userId: "user-manager-a" })).rejects
      .toMatchObject({ code: "authorization_denied", status: 403 });

    const later = new Date(NOW.getTime() + 25 * 60 * 60_000);
    const reused = await issueApiCredential({
      env,
      expiresAt: new Date(later.getTime() + 60 * 60_000).toISOString(),
      idempotencyKey: "api-credential-create-001",
      name: "Reused after retention",
      now: later,
      requestId: "request-api-credential-reused-key",
      scopes: ["shop:read"],
      shopPublicId: SHOP_A_PUBLIC_ID,
      userId: "user-owner-a",
    });
    expect(reused.replayed).toBe(false);
    expect(reused.tokenAvailable).toBe(true);
    expect(reused.credential.publicId).not.toBe(first.credential.publicId);
  });

  it("authenticates from the credential tenant, fails closed on tamper/revoke/expiry, and rate limits", async () => {
    const { database, env } = createRuntime();
    const issued = await issue(env);
    const token = issued.token as string;
    const request = new Request("https://api.example.test/api/v1/shop", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const context = await authenticatePublicApiRequest({
      env,
      now: NOW,
      request,
      requiredScope: "shop:read",
    });
    expect(context.shop).toEqual({
      currency: "VND",
      defaultLocale: "vi-VN",
      name: "API Shop A",
      publicId: SHOP_A_PUBLIC_ID,
      status: "active",
      timezone: "Asia/Ho_Chi_Minh",
    });
    expect(context.shopId).toBe("shop-a");
    expect(context.rateLimit).toMatchObject({ limit: 60, remaining: 59 });
    expect(database.prepare(`
      SELECT last_used_at AS lastUsedAt, version
      FROM api_credentials WHERE public_id = ?
    `).get(issued.credential.publicId)).toEqual({ lastUsedAt: NOW.toISOString(), version: 1 });

    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    await expect(authenticatePublicApiRequest({
      env,
      now: NOW,
      request: new Request("https://api.example.test/api/v1/shop", { headers: { Authorization: `Bearer ${tampered}` } }),
      requiredScope: "shop:read",
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });

    for (let count = 1; count < 60; count += 1) {
      await authenticatePublicApiRequest({ env, now: NOW, request, requiredScope: "shop:read" });
    }
    await expect(authenticatePublicApiRequest({ env, now: NOW, request, requiredScope: "shop:read" }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });

    const revoked = await revokeApiCredential({
      credentialPublicId: issued.credential.publicId,
      env,
      expectedVersion: issued.credential.version,
      idempotencyKey: "api-credential-revoke-001",
      now: new Date(NOW.getTime() + 1),
      reasonCode: "seller_revoked",
      requestId: "request-api-credential-revoke",
      shopPublicId: SHOP_A_PUBLIC_ID,
      userId: "user-owner-a",
    });
    const revocationRequestHash = (database.prepare(`
      SELECT revocation_request_hash AS revocationRequestHash
      FROM api_credentials WHERE public_id = ?
    `).get(issued.credential.publicId) as { revocationRequestHash: string }).revocationRequestHash;
    const exportedAfterRevoke = await buildStandardExportPayload({
      env,
      exportedAt: NOW.toISOString(),
      shop: {
        publicId: SHOP_A_PUBLIC_ID,
        role: "owner",
        shopId: "shop-a",
        slug: "api-a",
        status: "active",
      },
    });
    expect(JSON.stringify(exportedAfterRevoke)).not.toContain(revocationRequestHash);
    const revokeReplay = await revokeApiCredential({
      credentialPublicId: issued.credential.publicId,
      env,
      expectedVersion: issued.credential.version,
      idempotencyKey: "api-credential-revoke-001",
      now: new Date(NOW.getTime() + 2),
      reasonCode: "seller_revoked",
      requestId: "request-api-credential-revoke-replay",
      shopPublicId: SHOP_A_PUBLIC_ID,
      userId: "user-owner-a",
    });
    expect(revokeReplay).toEqual(revoked);
    const sameMillisecondLoser = await revokeApiCredential({
      credentialPublicId: issued.credential.publicId,
      env,
      expectedVersion: issued.credential.version,
      idempotencyKey: "api-credential-revoke-001",
      now: new Date(NOW.getTime() + 1),
      reasonCode: "seller_revoked",
      requestId: "request-api-credential-revoke-other-owner",
      shopPublicId: SHOP_A_PUBLIC_ID,
      userId: "user-owner-a2",
    });
    expect(sameMillisecondLoser).toEqual(revoked);
    expect(database.prepare(`
      SELECT COUNT(*) AS count, MIN(actor_id) AS actorId, MAX(actor_id) AS lastActorId
      FROM audit_logs
      WHERE shop_id = 'shop-a' AND action = 'api_credential.revoked'
    `).get()).toEqual({ actorId: "user-owner-a", count: 1, lastActorId: "user-owner-a" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM idempotency_records
      WHERE namespace LIKE 'api-credential.revoke.v1:%'
    `).get()).toEqual({ count: 1 });
    await expect(revokeApiCredential({
      credentialPublicId: issued.credential.publicId,
      env,
      expectedVersion: issued.credential.version,
      idempotencyKey: "api-credential-revoke-001",
      now: new Date(NOW.getTime() + 2),
      reasonCode: "credential_compromised",
      requestId: "request-api-credential-revoke-conflict",
      shopPublicId: SHOP_A_PUBLIC_ID,
      userId: "user-owner-a",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(authenticatePublicApiRequest({
      env,
      now: new Date(NOW.getTime() + 3),
      request,
      requiredScope: "shop:read",
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });

    const expiring = await issue(env, { idempotencyKey: "api-credential-create-expiring" });
    await expect(authenticatePublicApiRequest({
      env,
      now: new Date(NOW.getTime() + 2 * 60 * 60_000),
      request: new Request("https://api.example.test/api/v1/shop", {
        headers: { Authorization: `Bearer ${expiring.token as string}` },
      }),
      requiredScope: "shop:read",
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });
  });

  it("fails an in-flight request when revocation wins between lookup and final credential touch", async () => {
    let revokeBeforeTouch = false;
    const runtime = createRuntime((database, sql) => {
      if (!revokeBeforeTouch || !sql.includes("SET last_used_at = ?")) return;
      revokeBeforeTouch = false;
      database.prepare(`
        UPDATE api_credentials
        SET status = 'revoked', revoked_at = ?, revocation_request_hash = ?,
          revoke_reason = 'seller_revoked',
          version = version + 1, updated_at = ?
        WHERE shop_id = 'shop-a' AND status = 'active'
      `).run(NOW.toISOString(), "r".repeat(43), NOW.toISOString());
    });
    const issued = await issue(runtime.env);
    revokeBeforeTouch = true;
    await expect(authenticatePublicApiRequest({
      env: runtime.env,
      now: NOW,
      request: new Request("https://api.example.test/api/v1/shop", {
        headers: { Authorization: `Bearer ${issued.token as string}` },
      }),
      requiredScope: "shop:read",
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    expect(runtime.database.prepare(`
      SELECT status, version FROM api_credentials WHERE public_id = ?
    `).get(issued.credential.publicId)).toEqual({ status: "revoked", version: 2 });
  });
});
