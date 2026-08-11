import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  consumeZaloOfficialAccountOAuthState,
  consumeZaloOfficialAccountOAuthStateByState,
  issueZaloOfficialAccountOAuthState,
} from "../../src/lib/channels/zalo-oa-oauth-state-store";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const SHOP_ID = "shop-zalo-oa";
const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-0000000000a1";
const SECRET = "zalo-state-session-secret-123456";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONNECTOR_REQUEST_ID = "creq-zalo-oa-active";

class SqliteStatement {
  constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): SqliteStatement {
    const sqlValues = values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    });
    return new SqliteStatement(this.database, this.sql, sqlValues);
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

function applyMigrations(database: DatabaseSync, through = "0066"): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= through).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function seedShop(database: DatabaseSync, suffix = "", connectorStatus: "active" | "provider_pending" = "active"): void {
  const shopId = suffix === "" ? SHOP_ID : `${SHOP_ID}-${suffix}`;
  const publicId = suffix === "" ? SHOP_PUBLIC_ID : `${SHOP_PUBLIC_ID}-${suffix}`;
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-zalo-oa${suffix}', 'zalo_oa_${suffix === "" ? "base" : suffix}', 'Business', '{}', '{}', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('${shopId}', '${publicId}', 'zalo-oa-shop${suffix}', 'Zalo OA Shop', 'active', 'en', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at)
    VALUES ('subscription-zalo-oa${suffix}', '${shopId}', 'plan-zalo-oa${suffix}', 'active', '2099-01-01T00:00:00.000Z', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-zalo-oa${suffix}', 'zalo-oa${suffix}@example.com', 'Zalo OA Owner', 'active', '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('${shopId}', 'user-zalo-oa${suffix}', 'owner', 'active', '${now}', '${now}');
    INSERT INTO channel_connector_requests (
      id, public_id, shop_id, channel_code, provider_code, requested_by_user_id,
      status, provider_reference_hash, reviewed_by_user_id, reviewed_at,
      idempotency_key_hash, request_hash, created_at, updated_at, version
    ) VALUES (
      '${CONNECTOR_REQUEST_ID}${suffix}', '${CONNECTOR_REQUEST_ID}${suffix}', '${shopId}', 'zalo.oa', 'zalo.oa', 'user-zalo-oa${suffix}',
      '${connectorStatus}', 'provider-reference-hash', 'user-zalo-oa${suffix}', '${now}',
      'idempotency-key-hash', 'request-hash', '${now}', '${now}', 1
    );
  `);
}

function bindings(database: SqliteD1): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    APP_ENV: "local",
    CREDENTIAL_KEK_V1: KEK,
    IDENTIFIER_HMAC_SECRET: "zalo-oa-identity-hmac-secret",
    PLATFORM_DB: database,
    SESSION_SECRET: SECRET,
  } as unknown as AppBindings;
}

describe("Zalo Official Account OAuth state store", () => {
  let database: DatabaseSync;
  let d1: SqliteD1;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seedShop(database);
    d1 = new SqliteD1(database);
    env = bindings(d1);
  });

  afterEach(() => {
    database.close();
  });

  it("issues a tenant-bound state and consumes it exactly once", async () => {
    const issued = await issueZaloOfficialAccountOAuthState({
      ...env,
      appId: "zalo-app-123",
      connectorRequestId: CONNECTOR_REQUEST_ID,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopId: SHOP_ID,
    });
    expect(issued).toMatchObject({ appId: "zalo-app-123", providerCode: "zalo.oa", shopId: SHOP_ID, status: "pending" });
    expect(new URL(issued.authorizationUrl).searchParams.get("state")).toBe(issued.state);

    const row = database.prepare("SELECT state_hash AS stateHash, code_verifier_ciphertext_b64 AS ciphertext, status FROM channel_oauth_states WHERE request_id = ?").get(issued.requestId) as { ciphertext: string; stateHash: string; status: string };
    expect(row.status).toBe("pending");
    expect(row.stateHash).not.toBe(issued.state);
    expect(row.ciphertext).not.toContain(issued.state);

    const consumed = await consumeZaloOfficialAccountOAuthState({ ...env, now: NOW, receivedState: issued.state, requestId: issued.requestId, shopId: SHOP_ID });
    expect(consumed).toMatchObject({
      appId: "zalo-app-123",
      providerCode: "zalo.oa",
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      requestId: issued.requestId,
      shopId: SHOP_ID,
    });
    expect(consumed.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43}$/u);
    expect((database.prepare("SELECT status FROM channel_oauth_states WHERE request_id = ?").get(issued.requestId) as { status: string }).status).toBe("consumed");
    await expect(consumeZaloOfficialAccountOAuthState({ ...env, now: NOW, receivedState: issued.state, requestId: issued.requestId, shopId: SHOP_ID })).rejects.toMatchObject({ code: "zalo_oa_oauth_state_replay", status: 409 });

    const retried = await issueZaloOfficialAccountOAuthState({
      ...env,
      appId: "zalo-app-123",
      connectorRequestId: CONNECTOR_REQUEST_ID,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopId: SHOP_ID,
    });
    expect(retried.requestId).not.toBe(issued.requestId);
    expect((database.prepare("SELECT COUNT(*) AS count FROM channel_oauth_states WHERE shop_id = ? AND connector_request_id = ?").get(SHOP_ID, CONNECTOR_REQUEST_ID) as { count: number }).count).toBe(2);
  });

  it("resolves and consumes a callback state without a browser tenant identifier", async () => {
    const issued = await issueZaloOfficialAccountOAuthState({
      ...env,
      appId: "zalo-app-123",
      connectorRequestId: CONNECTOR_REQUEST_ID,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopId: SHOP_ID,
    });
    const consumed = await consumeZaloOfficialAccountOAuthStateByState({
      ...env,
      now: NOW,
      receivedState: issued.state,
    });
    expect(consumed).toMatchObject({ requestId: issued.requestId, shopId: SHOP_ID });
    await expect(consumeZaloOfficialAccountOAuthStateByState({ ...env, now: NOW, receivedState: issued.state }))
      .rejects.toMatchObject({ code: "zalo_oa_oauth_state_replay", status: 409 });
  });

  it("rejects wrong tenant, wrong state, and expired state without consuming it", async () => {
    const issued = await issueZaloOfficialAccountOAuthState({
      ...env,
      appId: "zalo-app-123",
      connectorRequestId: CONNECTOR_REQUEST_ID,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopId: SHOP_ID,
    });
    seedShop(database, "other");
    await expect(consumeZaloOfficialAccountOAuthState({ ...env, now: NOW, receivedState: issued.state, requestId: issued.requestId, shopId: `${SHOP_ID}-other` })).rejects.toMatchObject({ code: "zalo_oa_oauth_state_not_found", status: 404 });
    const wrongState = `${issued.state.slice(0, -1)}${issued.state.endsWith("A") ? "B" : "A"}`;
    await expect(consumeZaloOfficialAccountOAuthState({ ...env, now: NOW, receivedState: wrongState, requestId: issued.requestId, shopId: SHOP_ID })).rejects.toMatchObject({ code: "zalo_oa_oauth_invalid", status: 400 });
    await expect(consumeZaloOfficialAccountOAuthState({ ...env, now: new Date(NOW.getTime() + 11 * 60_000), receivedState: issued.state, requestId: issued.requestId, shopId: SHOP_ID })).rejects.toMatchObject({ code: "zalo_oa_oauth_state_expired", status: 409 });
    expect((database.prepare("SELECT status FROM channel_oauth_states WHERE request_id = ?").get(issued.requestId) as { status: string }).status).toBe("pending");
  });

  it("prevents direct-D1 expiry extension while state is pending", async () => {
    const issued = await issueZaloOfficialAccountOAuthState({
      ...env,
      appId: "zalo-app-123",
      connectorRequestId: CONNECTOR_REQUEST_ID,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopId: SHOP_ID,
    });
    expect(() => database.prepare("UPDATE channel_oauth_states SET expires_at = ?, updated_at = ?, version = version + 1 WHERE request_id = ?").run("2026-08-03T12:00:00.000Z", NOW.toISOString(), issued.requestId)).toThrow("channel_oauth_state_transition_invalid");
  });

  it("requires the connector request to match the tenant and provider scope", async () => {
    seedShop(database, "other");
    await expect(issueZaloOfficialAccountOAuthState({
      ...env,
      appId: "zalo-app-123",
      connectorRequestId: `${CONNECTOR_REQUEST_ID}other`,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "zalo_oa_oauth_connector_scope_invalid", status: 409 });

    seedShop(database, "pending", "provider_pending");
    await expect(issueZaloOfficialAccountOAuthState({
      ...env,
      appId: "zalo-app-123",
      connectorRequestId: `${CONNECTOR_REQUEST_ID}pending`,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopId: `${SHOP_ID}-pending`,
    })).resolves.toMatchObject({ connectorRequestId: `${CONNECTOR_REQUEST_ID}pending`, status: "pending" });
  });

  it("allows a new state after consumption or revocation but fences concurrent pending state", async () => {
    const issue = () => issueZaloOfficialAccountOAuthState({
      ...env,
      appId: "zalo-app-123",
      connectorRequestId: CONNECTOR_REQUEST_ID,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopId: SHOP_ID,
    });

    const first = await issue();
    await consumeZaloOfficialAccountOAuthState({ ...env, now: NOW, receivedState: first.state, requestId: first.requestId, shopId: SHOP_ID });
    const second = await issue();
    expect(second.requestId).not.toBe(first.requestId);
    await expect(issue()).rejects.toMatchObject({ code: "zalo_oa_oauth_state_conflict", status: 409 });

    database.prepare(`
      UPDATE channel_oauth_states
      SET status = 'revoked', revoked_at = ?, updated_at = ?, version = version + 1
      WHERE request_id = ? AND status = 'pending'
    `).run(NOW.toISOString(), NOW.toISOString(), second.requestId);
    const third = await issue();
    expect(third.requestId).not.toBe(second.requestId);
  });

  it("preserves an existing pending row while migrating the uniqueness fence", async () => {
    const legacyDatabase = new DatabaseSync(":memory:");
    try {
      legacyDatabase.exec("PRAGMA foreign_keys = ON");
      applyMigrations(legacyDatabase, "0066");
      seedShop(legacyDatabase);
      const legacyEnv = bindings(new SqliteD1(legacyDatabase));
      const issued = await issueZaloOfficialAccountOAuthState({
        ...legacyEnv,
        appId: "zalo-app-123",
        connectorRequestId: CONNECTOR_REQUEST_ID,
        expiresAt: new Date(NOW.getTime() + 10 * 60_000),
        now: NOW,
        redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
        shopId: SHOP_ID,
      });
      legacyDatabase.exec(readFileSync(join(process.cwd(), "migrations", "0062_zalo_oa_oauth_state_retry.sql"), "utf8"));
      expect(legacyDatabase.prepare("SELECT status, request_id AS requestId FROM channel_oauth_states WHERE request_id = ?").get(issued.requestId)).toEqual({ status: "pending", requestId: issued.requestId });
      expect(legacyDatabase.prepare("SELECT name, partial FROM pragma_index_list('channel_oauth_states') WHERE name = 'idx_channel_oauth_states_pending_connector'").get()).toEqual({ name: "idx_channel_oauth_states_pending_connector", partial: 1 });
    } finally {
      legacyDatabase.close();
    }
  });
});
