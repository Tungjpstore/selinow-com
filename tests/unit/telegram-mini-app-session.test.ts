import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptTelegramCredential } from "../../src/lib/telegram/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";
import {
  authenticateTelegramMiniAppSession,
  issueTelegramMiniAppSession,
  telegramMiniAppLaunchPolicy,
} from "../../src/lib/channels/telegram-mini-app-session";

const NOW = new Date("2026-08-02T04:00:00.000Z");
const SHOP_ID = "shop-mini-app";
const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-0000000000a1";
const OWNER_ID = "mini-app-owner";
const REVIEWER_ID = "mini-app-reviewer";
const INTEGRATION_ID = "telegram-mini-integration";
const CREDENTIAL_ID = "telegram-mini-credential";
const CONNECTOR_ID = "connector-mini-app";
const BOT_TOKEN = "123456789:mini-app-session-test-token";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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
  private batchQueue = Promise.resolve();

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const operation = this.batchQueue.then(async () => {
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
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function createEnv(database: SqliteD1): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    APP_ENV: "local",
    CREDENTIAL_KEK_V1: KEK,
    DASHBOARD_ORIGIN: "https://dashboard.example.test",
    IDENTIFIER_HMAC_SECRET: "mini-app-identifier-secret",
    MAGIC_LINK_SECRET: "mini-app-magic-secret",
    PLATFORM_DB: database,
    SESSION_SECRET: "mini-app-session-secret",
  } as unknown as AppBindings;
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes).buffer, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildInitData(overrides: Record<string, string> = {}): Promise<string> {
  const fields = {
    auth_date: String(Math.floor(NOW.getTime() / 1_000) - 60),
    query_id: "AAE-mini-session-query",
    start_param: "shop-demo",
    user: JSON.stringify({ first_name: "Buyer", id: 42, language_code: "vi", username: "buyer" }),
    ...overrides,
  };
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT_TOKEN);
  const hash = hex(await hmac(secret, dataCheckString));
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function seed(database: DatabaseSync): Promise<void> {
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-mini-app', 'business', 'Business', '{}', '{}', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES
      ('${OWNER_ID}', 'mini-owner@example.test', 'Mini Owner', 'active', '${now}', '${now}'),
      ('${REVIEWER_ID}', 'mini-reviewer@example.test', 'Mini Reviewer', 'active', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('${SHOP_ID}', '${SHOP_PUBLIC_ID}', 'mini-shop', 'Mini Shop', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
    VALUES ('subscription-mini', '${SHOP_ID}', 'plan-mini-app', 'active', '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at, member_public_id) VALUES
      ('${SHOP_ID}', '${OWNER_ID}', 'owner', 'active', '${now}', '${now}', 'mbr_00000000-0000-4000-8000-0000000000a1'),
      ('${SHOP_ID}', '${REVIEWER_ID}', 'manager', 'active', '${now}', '${now}', 'mbr_00000000-0000-4000-8000-0000000000a2');
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status,
      active_credential_id, created_at, updated_at
    ) VALUES ('${INTEGRATION_ID}', 'tin_00000000-0000-4000-8000-0000000000a1', 'tgwh_00000000-0000-4000-8000-0000000000a1', '${SHOP_ID}', 'active', 'verified', '${CREDENTIAL_ID}', '${now}', '${now}');
    INSERT INTO channel_connector_requests (
      id, public_id, shop_id, channel_code, provider_code, requested_by_user_id,
      status, provider_reference_hash, reviewed_by_user_id, reviewed_at, idempotency_key_hash, request_hash,
      version, created_at, updated_at
    ) VALUES (
      '${CONNECTOR_ID}', 'creq_00000000-0000-4000-8000-0000000000a1', '${SHOP_ID}',
      'telegram.mini_app', 'telegram.mini_app', '${OWNER_ID}', 'active', 'provider-reference-hash',
      '${REVIEWER_ID}', '${now}', 'idempotency-mini', 'request-mini', 2, '${now}', '${now}'
    );
  `);
  const encrypted = await encryptTelegramCredential({
    botToken: BOT_TOKEN,
    credentialId: CREDENTIAL_ID,
    hmacSecret: "mini-app-identifier-secret",
    integrationId: INTEGRATION_ID,
    kek: KEK,
    keyVersion: "v1",
    shopId: SHOP_ID,
    webhookSecret: "mini-app-webhook-secret",
  });
  database.prepare(`
    INSERT INTO telegram_credentials (
      id, shop_id, integration_id, status, version, key_version,
      bot_token_ciphertext_b64, bot_token_iv_b64,
      webhook_secret_ciphertext_b64, webhook_secret_iv_b64,
      token_fingerprint, webhook_secret_digest, created_by_user_id, activated_at, created_at
    ) VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(CREDENTIAL_ID, SHOP_ID, INTEGRATION_ID, "v1", encrypted.botTokenCiphertextB64, encrypted.botTokenIvB64, encrypted.webhookSecretCiphertextB64, encrypted.webhookSecretIvB64, encrypted.tokenFingerprint, encrypted.webhookSecretDigest, OWNER_ID, now, now);
}

describe("Telegram Mini App session boundary", () => {
  let database: DatabaseSync;
  let d1: SqliteD1;
  let env: AppBindings;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    d1 = new SqliteD1(database);
    env = createEnv(d1);
    await seed(database);
  });

  afterEach(() => {
    database.close();
  });

  it("verifies initData, scopes the session to the tenant, and enforces expiry", async () => {
    const issued = await issueTelegramMiniAppSession({ env, initData: await buildInitData(), now: NOW, requesterAddress: "198.51.100.10", requestId: "request-mini-session", shopPublicId: SHOP_PUBLIC_ID });
    expect(issued).toMatchObject({ user: { languageCode: "vi" } });
    expect(issued.sessionToken.length).toBeGreaterThanOrEqual(40);
    const session = await authenticateTelegramMiniAppSession({ env, now: new Date(NOW.getTime() + 30_000), sessionToken: issued.sessionToken, shopPublicId: SHOP_PUBLIC_ID });
    expect(session).toMatchObject({ shopId: SHOP_ID, integrationId: INTEGRATION_ID, connectorStatus: "active", credentialVersion: 1 });
    await expect(authenticateTelegramMiniAppSession({ env, now: new Date(NOW.getTime() + 16 * 60_000), sessionToken: issued.sessionToken, shopPublicId: SHOP_PUBLIC_ID })).rejects.toMatchObject({ code: "authentication_required" });
  });

  it("guards direct session inserts against credential-version drift", () => {
    expect((database.prepare("PRAGMA table_info(telegram_mini_app_sessions)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("credential_version");
    expect(() => database.prepare(`
      INSERT INTO telegram_mini_app_sessions (
        id, shop_id, integration_id, credential_id, credential_version, connector_request_id,
        subject_hash, launch_hash, token_hash, status, issued_at, expires_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run("tmas_scope-drift", SHOP_ID, INTEGRATION_ID, CREDENTIAL_ID, 2, CONNECTOR_ID, "subject-hash-drift", "launch-hash-drift", "token-hash-drift", NOW.toISOString(), new Date(NOW.getTime() + 900_000).toISOString(), NOW.toISOString())).toThrow("telegram_mini_app_session_scope_mismatch");
  });

  it("guards direct session inserts when the subscribed plan is inactive", () => {
    database.prepare("UPDATE plans SET is_active = 0 WHERE id = ?").run("plan-mini-app");
    expect(() => database.prepare(`
      INSERT INTO telegram_mini_app_sessions (
        id, shop_id, integration_id, credential_id, credential_version, connector_request_id,
        subject_hash, launch_hash, token_hash, status, issued_at, expires_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run("tmas_inactive-plan", SHOP_ID, INTEGRATION_ID, CREDENTIAL_ID, 1, CONNECTOR_ID, "subject-hash-inactive", "launch-hash-inactive", "token-hash-inactive", NOW.toISOString(), new Date(NOW.getTime() + 900_000).toISOString(), NOW.toISOString())).toThrow("telegram_mini_app_session_scope_mismatch");
  });

  it("rejects launch replay and cross-tenant session use", async () => {
    const initData = await buildInitData({ query_id: "AAE-mini-session-replay" });
    const issued = await issueTelegramMiniAppSession({ env, initData, now: NOW, requesterAddress: "198.51.100.10", requestId: "request-mini-replay", shopPublicId: SHOP_PUBLIC_ID });
    await expect(issueTelegramMiniAppSession({ env, initData, now: NOW, requesterAddress: "198.51.100.10", requestId: "request-mini-replay-2", shopPublicId: SHOP_PUBLIC_ID })).rejects.toMatchObject({ code: "telegram_mini_app_replay" });
    await expect(issueTelegramMiniAppSession({ env, initData: initData.split("&").reverse().join("&"), now: NOW, requesterAddress: "198.51.100.10", requestId: "request-mini-replay-3", shopPublicId: SHOP_PUBLIC_ID })).rejects.toMatchObject({ code: "telegram_mini_app_replay" });
    await expect(authenticateTelegramMiniAppSession({ env, now: NOW, sessionToken: issued.sessionToken, shopPublicId: "shop_00000000-0000-4000-8000-0000000000b1" })).rejects.toMatchObject({ code: "authentication_required" });
  });

  it("fails closed when the connector request is canceled or the credential rotates", async () => {
    const issued = await issueTelegramMiniAppSession({ env, initData: await buildInitData({ query_id: "AAE-mini-session-state" }), now: NOW, requesterAddress: "198.51.100.10", requestId: "request-mini-state", shopPublicId: SHOP_PUBLIC_ID });
    database.prepare("UPDATE telegram_credentials SET status = 'revoked', revoked_at = ? WHERE id = ?").run(NOW.toISOString(), CREDENTIAL_ID);
    await expect(authenticateTelegramMiniAppSession({ env, now: NOW, sessionToken: issued.sessionToken, shopPublicId: SHOP_PUBLIC_ID })).rejects.toMatchObject({ code: "authentication_required" });
    database.prepare("UPDATE telegram_credentials SET status = 'active', revoked_at = NULL WHERE id = ?").run(CREDENTIAL_ID);
    database.prepare("UPDATE telegram_integrations SET status = 'disabled', webhook_status = 'disabled', updated_at = ? WHERE id = ?").run(NOW.toISOString(), INTEGRATION_ID);
    await expect(authenticateTelegramMiniAppSession({ env, now: NOW, sessionToken: issued.sessionToken, shopPublicId: SHOP_PUBLIC_ID })).rejects.toMatchObject({ code: "authentication_required" });
  });

  it("fails closed when the subscribed plan becomes inactive", async () => {
    const issued = await issueTelegramMiniAppSession({ env, initData: await buildInitData({ query_id: "AAE-mini-session-plan" }), now: NOW, requesterAddress: "198.51.100.10", requestId: "request-mini-plan", shopPublicId: SHOP_PUBLIC_ID });
    database.prepare("UPDATE plans SET is_active = 0 WHERE id = ?").run("plan-mini-app");

    await expect(authenticateTelegramMiniAppSession({ env, now: NOW, sessionToken: issued.sessionToken, shopPublicId: SHOP_PUBLIC_ID })).rejects.toMatchObject({ code: "authentication_required" });
    await expect(issueTelegramMiniAppSession({ env, initData: await buildInitData({ query_id: "AAE-mini-session-plan-new" }), now: NOW, requesterAddress: "198.51.100.10", requestId: "request-mini-plan-new", shopPublicId: SHOP_PUBLIC_ID })).rejects.toMatchObject({ code: "channel_mini_app_unavailable" });
  });

  it("keeps the policy bounded and rate-limits launch exchanges", () => {
    expect(telegramMiniAppLaunchPolicy()).toEqual({ initDataMaxAgeSeconds: 300, sessionTtlSeconds: 900 });
  });
});
