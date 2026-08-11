import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hmacToken } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { connectPayOS, disconnectPayOS, getPaymentIntegration, refreshPayOSHealth } from "../../src/lib/payments/integrations";
import { encryptPayOSCredentials, type PayOSCredentials } from "../../src/lib/payments/crypto";
import { payOSProviderIdentityFingerprint } from "../../src/lib/payments/payos-admission";
import { connectTelegram, disconnectTelegram, refreshTelegramHealth } from "../../src/lib/telegram/integrations";
import { encryptTelegramCredential, type EncryptedTelegramCredential } from "../../src/lib/telegram/crypto";

const membership = vi.hoisted(() => ({ role: "owner" }));

vi.mock("../../src/lib/tenants/store", () => ({
  getShopForMember: vi.fn(() => Promise.resolve({
    row: { role: membership.role, shop_id: "shop-a" },
    shop: {},
  })),
}));

const API_ORIGIN = "https://api.test";
const IDENTIFIER_SECRET = "identifier-secret";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAYOS_CREDENTIALS: PayOSCredentials = {
  apiKey: "payos-api-key",
  checksumKey: "payos-checksum-key",
  clientId: "payos-client-id",
};
const PAYOS_ROTATED_CREDENTIALS: PayOSCredentials = {
  apiKey: "payos-rotated-api-key",
  checksumKey: "payos-rotated-checksum-key",
  clientId: PAYOS_CREDENTIALS.clientId,
};
const TELEGRAM_BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDE";
const TELEGRAM_REPLACEMENT_TOKEN = "987654321:ZYXWVUTSRQPONMLKJIHGFEDCBAabcde";
const TELEGRAM_WEBHOOK_SECRET = "existing-webhook-secret_123456789";

type SqlStatement = { run: () => Promise<unknown> };
const payOSDatabases: DatabaseSync[] = [];

class ResumabilitySqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): ResumabilitySqliteStatement {
    return new ResumabilitySqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }));
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all<T>(): Promise<D1Result<T>> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) as T[] } as D1Result<T>);
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function applyAllMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function binding(database: object): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    API_ORIGIN,
    CREDENTIAL_KEK_V1: KEK,
    CREDENTIAL_KEY_VERSION: "v1",
    IDENTIFIER_HMAC_SECRET: IDENTIFIER_SECRET,
    PLATFORM_DB: database,
    TELEGRAM_WEBHOOK_MAX_CONNECTIONS: "20",
  } as unknown as AppBindings;
}

async function telegramRuntime() {
  const encrypted = await encryptTelegramCredential({
    botToken: TELEGRAM_BOT_TOKEN,
    credentialId: "telegram-credential-a",
    hmacSecret: IDENTIFIER_SECRET,
    integrationId: "telegram-integration-a",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
    webhookSecret: TELEGRAM_WEBHOOK_SECRET,
  });
  const integration = {
    activeCredentialId: null as string | null,
    botDisplayName: "Resume Bot" as string | null,
    botId: "123456789" as string | null,
    botUsername: "resume_bot" as string | null,
    connectedAt: null as string | null,
    id: "telegram-integration-a",
    lastCheckedAt: null as string | null,
    lastHealthUpdateAt: null as string | null,
    lastOutboundAt: null as string | null,
    lastSafeErrorCode: "telegram_webhook_failed" as string | null,
    lastUpdateAt: null as string | null,
    pendingUpdateCount: 0,
    publicId: "telegram-public-a",
    shopId: "shop-a",
    status: "error",
    webhookPublicId: "telegram-webhook-a",
    webhookStatus: "error",
  };
  const credential = {
    ...encrypted,
    credentialId: "telegram-credential-a",
    integrationId: integration.id,
    keyVersion: "v1",
    shopId: "shop-a",
    status: "error",
    version: 4,
  };
  const sqlHistory: string[] = [];
  const webhookSecrets: string[] = [];
  let credentialInsertCount = 0;
  let webhookSetupCount = 0;

  const database = {
    prepare(sql: string) {
      sqlHistory.push(sql);
      if (sql.includes("INSERT INTO telegram_credentials")) credentialInsertCount += 1;
      return {
        bind(...values: unknown[]) {
          return {
            first() {
              if (sql.includes("FROM telegram_integrations WHERE shop_id")) return Promise.resolve({ ...integration });
              if (sql.includes("FROM telegram_integrations WHERE bot_id")) return Promise.resolve(null);
              if (sql.includes("FROM telegram_credentials") && sql.includes("token_fingerprint = ?")) {
                return Promise.resolve({ ...credential });
              }
              if (sql.includes("FROM telegram_credentials") && sql.includes("status IN ('pending', 'error')")) {
                return Promise.resolve(new Set(["pending", "error"]).has(credential.status) ? { ...credential } : null);
              }
              if (sql.includes("FROM telegram_credentials") && sql.includes("status = 'active'")) {
                return Promise.resolve(credential.status === "active" ? { ...credential } : null);
              }
              return Promise.resolve(null);
            },
            run() {
              if (sql.includes("UPDATE telegram_credentials SET status = 'pending'")) credential.status = "pending";
              if (sql.includes("UPDATE telegram_credentials SET status = 'active'")) {
                credential.status = "active";
              }
              if (sql.includes("UPDATE telegram_credentials SET status = 'revoked'") && sql.includes("status IN ('active', 'pending')")) {
                credential.status = "revoked";
              }
              if (sql.includes("UPDATE telegram_integrations SET status = CASE")) {
                integration.status = integration.activeCredentialId === null ? "pending" : integration.status;
                integration.webhookStatus = integration.activeCredentialId === null ? "pending" : integration.webhookStatus;
                integration.lastSafeErrorCode = null;
              }
              if (sql.includes("UPDATE telegram_integrations SET status = ?")) {
                integration.status = String(values[0]);
                integration.webhookStatus = "verified";
                integration.activeCredentialId = String(values[1]);
                if (values[2] === 1) integration.lastHealthUpdateAt = null;
                integration.botId = String(values[3]);
                integration.botUsername = String(values[4]);
                integration.botDisplayName = String(values[5]);
                integration.pendingUpdateCount = Number(values[6]);
                integration.lastSafeErrorCode = typeof values[7] === "string" ? values[7] : null;
                integration.lastCheckedAt = String(values[8]);
                integration.connectedAt ??= String(values[9]);
              }
              if (sql.includes("UPDATE telegram_integrations SET status = 'disabled'")) {
                integration.status = "disabled";
                integration.webhookStatus = "disabled";
                integration.activeCredentialId = null;
                if (sql.includes("last_health_update_at = NULL")) integration.lastHealthUpdateAt = null;
                integration.lastSafeErrorCode = null;
              }
              return Promise.resolve({ meta: { changes: 1 } });
            },
          };
        },
      };
    },
    batch(statements: SqlStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };

  const fetcher: typeof fetch = (request, init) => {
    const url = request instanceof Request ? request.url : request.toString();
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    if (method === "setWebhook") {
      webhookSetupCount += 1;
      webhookSecrets.push(String(body.secret_token));
    }
    const result = method === "getMe"
      ? { first_name: "Resume Bot", id: 123_456_789, is_bot: true, username: "resume_bot" }
      : method === "getWebhookInfo"
        ? { allowed_updates: ["message", "callback_query"], max_connections: 20, pending_update_count: 0, url: `${API_ORIGIN}/webhooks/telegram/${integration.webhookPublicId}` }
        : true;
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
  };

  return {
    credential,
    env: binding(database),
    fetcher,
    getCredentialInsertCount: () => credentialInsertCount,
    getWebhookSetupCount: () => webhookSetupCount,
    integration,
    sqlHistory,
    webhookSecrets,
  };
}

async function payOSRuntime(input: {
  active?: boolean;
  currentPeriodEnd?: string | null | undefined;
  graceEndsAt?: string | null;
  pending?: boolean;
  providerFails?: boolean;
  subscriptionQueryFails?: boolean;
  subscriptionState?: "pending_payment" | "trialing" | "active" | "past_due" | "grace_period" | "suspended" | "cancel_scheduled" | "upgrade_pending" | "downgrade_scheduled";
  trialEndsAt?: string | null | undefined;
  withoutSubscription?: boolean;
} = {}) {
  const database = new DatabaseSync(":memory:");
  payOSDatabases.push(database);
  applyAllMigrations(database);
  const encrypted = await encryptPayOSCredentials(PAYOS_CREDENTIALS, {
    credentialId: "payos-credential-a",
    hmacSecret: IDENTIFIER_SECRET,
    integrationId: "payos-integration-a",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
  });
  const active = input.active === true;
  const pending = !active && input.pending === true;
  const now = "2026-07-25T00:00:00.000Z";
  const providerIdentityFingerprint = active
    ? await payOSProviderIdentityFingerprint({ IDENTIFIER_HMAC_SECRET: IDENTIFIER_SECRET }, PAYOS_CREDENTIALS)
    : null;
  const providerOwnershipFingerprint = active
    ? await hmacToken(
      IDENTIFIER_SECRET,
      "payos-provider-credential:v1",
      `${PAYOS_CREDENTIALS.clientId}\0${PAYOS_CREDENTIALS.apiKey}\0${PAYOS_CREDENTIALS.checksumKey}`,
    )
    : null;
  const integration = {
    activeCredentialId: active ? "payos-credential-a" : null as string | null,
    connectedAt: active ? now : null as string | null,
    id: "payos-integration-a",
    lastCheckedAt: active ? now : null as string | null,
    lastSafeErrorCode: active || pending ? null : "provider_verification_failed" as string | null,
    lastWebhookVerifiedAt: active ? now : null as string | null,
    providerClaimGeneration: 0,
    providerClaimNonce: null as string | null,
    providerClaimState: "idle" as const,
    providerClaimTargetFingerprint: null as string | null,
    providerIdentityFingerprint,
    publicId: "payos-public-a",
    status: active ? "active" : pending ? "pending" : "error",
    webhookPublicId: "payos-webhook-a",
    webhookStatus: active ? "verified" : pending ? "pending" : "error",
  };
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('owner-a', 'owner-a@example.test', 'Owner A', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (
      'shop-a', 'shop-public-a', 'shop-a', 'Shop A', 'active', 'en', 'VND',
      'Asia/Ho_Chi_Minh', 1, ?, ?
    )
  `).run(now, now);
  if (input.subscriptionState === "trialing" && input.trialEndsAt != null
    && Date.parse(input.trialEndsAt) <= Date.now()) {
    // Simulate a valid trial row whose deadline elapsed after it was created.
    database.exec("DROP TRIGGER shop_subscriptions_trialing_insert_guard");
  }
  if (input.withoutSubscription !== true) {
    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, trial_ends_at, current_period_end,
        grace_ends_at, created_at, updated_at
      ) VALUES ('subscription-a', 'shop-a', 'plan_starter_v1', ?, ?, ?, ?, ?, ?)
    `).run(
      input.subscriptionState ?? "active",
      input.trialEndsAt ?? null,
      input.currentPeriodEnd === undefined ? "2099-01-01T00:00:00.000Z" : input.currentPeriodEnd,
      input.graceEndsAt ?? null,
      now,
      now,
    );
  }
  database.prepare(`
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status,
      webhook_status, provider_identity_fingerprint, connected_at,
      last_safe_error_code, last_checked_at, last_webhook_verified_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'shop-a', 'payos', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    integration.id,
    integration.publicId,
    integration.webhookPublicId,
    integration.status,
    integration.webhookStatus,
    integration.providerIdentityFingerprint,
    integration.connectedAt,
    integration.lastSafeErrorCode,
    integration.lastCheckedAt,
    integration.lastWebhookVerifiedAt,
    now,
    now,
  );
  database.prepare(`
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, provider_ownership_fingerprint,
      created_by_user_id, created_at, activated_at
    ) VALUES (?, 'shop-a', ?, 'payos', ?, 7, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, 'owner-a', ?, ?)
  `).run(
    "payos-credential-a",
    integration.id,
    active ? "active" : pending ? "pending" : "error",
    encrypted.clientIdCiphertextB64,
    encrypted.clientIdIvB64,
    encrypted.apiKeyCiphertextB64,
    encrypted.apiKeyIvB64,
    encrypted.checksumKeyCiphertextB64,
    encrypted.checksumKeyIvB64,
    encrypted.fingerprint,
    providerOwnershipFingerprint,
    now,
    active ? now : null,
  );
  if (active) {
    database.prepare(`
      UPDATE payment_integrations
      SET active_credential_id = ?
      WHERE id = ? AND shop_id = 'shop-a'
    `).run("payos-credential-a", integration.id);
  }

  const credential = {
    credentialId: "payos-credential-a",
    get status() {
      const row = database.prepare(`
        SELECT status FROM payment_credentials WHERE id = ? AND shop_id = 'shop-a'
      `).get("payos-credential-a") as { status: string };
      return row.status;
    },
    version: 7,
  };
  const sqlHistory: string[] = [];
  let credentialInsertCount = 0;
  let providerCalls = 0;

  const d1Database = {
    prepare(sql: string) {
      sqlHistory.push(sql);
      if (sql.includes("INSERT INTO payment_credentials")) credentialInsertCount += 1;
      if (input.subscriptionQueryFails === true && sql.includes("FROM shop_subscriptions")) {
        const failedStatement = {
          bind() {
            return failedStatement;
          },
          first() {
            return Promise.reject(new Error("subscription_query_failed"));
          },
        };
        return failedStatement as unknown as D1PreparedStatement;
      }
      return new ResumabilitySqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
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
  };
  const fetcher: typeof fetch = (_request, init) => {
    providerCalls += 1;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    expect(body).toEqual({ webhookUrl: `${API_ORIGIN}/webhooks/payos/${integration.webhookPublicId}` });
    if (input.providerFails === true) {
      return Promise.resolve(new Response(JSON.stringify({ code: "01", desc: "sensitive provider description" }), { status: 400 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
  };

  return {
    credential,
    env: binding(d1Database),
    fetcher,
    getCredentialInsertCount: () => credentialInsertCount,
    getProviderCalls: () => providerCalls,
    integration,
    sqlHistory,
  };
}

async function telegramReplacementRuntime(input: { sameBot?: boolean } = {}) {
  type Credential = EncryptedTelegramCredential & {
    activatedAt: string | null;
    credentialId: string;
    integrationId: string;
    keyVersion: string;
    shopId: string;
    status: string;
    version: number;
  };

  const oldEncrypted = await encryptTelegramCredential({
    botToken: TELEGRAM_BOT_TOKEN,
    credentialId: "telegram-credential-old",
    hmacSecret: IDENTIFIER_SECRET,
    integrationId: "telegram-integration-replace",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
    webhookSecret: "old-webhook-secret_123456789",
  });
  const credentials: Credential[] = [{
    ...oldEncrypted,
    activatedAt: "2026-07-25T00:00:00.000Z",
    credentialId: "telegram-credential-old",
    integrationId: "telegram-integration-replace",
    keyVersion: "v1",
    shopId: "shop-a",
    status: "active",
    version: 1,
  }];
  const integration = {
    activeCredentialId: "telegram-credential-old" as string | null,
    botDisplayName: input.sameBot === true ? "Replacement Bot" : "Old Bot" as string | null,
    botId: input.sameBot === true ? "987654321" : "111111111" as string | null,
    botUsername: input.sameBot === true ? "replacement_bot" : "old_bot" as string | null,
    connectedAt: "2026-07-25T00:00:00.000Z" as string | null,
    id: "telegram-integration-replace",
    lastCheckedAt: "2026-07-25T00:00:00.000Z" as string | null,
    lastHealthUpdateAt: "2026-07-25T00:01:00.000Z" as string | null,
    lastOutboundAt: "2026-07-25T00:01:00.000Z" as string | null,
    lastSafeErrorCode: null as string | null,
    lastUpdateAt: "2026-07-25T00:01:00.000Z" as string | null,
    pendingUpdateCount: 0,
    publicId: "telegram-public-replace",
    shopId: "shop-a",
    status: "active",
    webhookPublicId: "telegram-webhook-replace",
    webhookStatus: "verified",
  };

  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first() {
              if (sql.includes("FROM telegram_integrations WHERE shop_id")) return Promise.resolve({ ...integration });
              if (sql.includes("FROM telegram_integrations WHERE bot_id")) return Promise.resolve(null);
              if (sql.includes("FROM telegram_credentials") && sql.includes("token_fingerprint = ?")) {
                const fingerprint = values[2];
                return Promise.resolve(credentials.find((row) => row.tokenFingerprint === fingerprint && new Set(["active", "pending", "error"]).has(row.status)) ?? null);
              }
              if (sql.includes("SELECT COALESCE(MAX(version)")) return Promise.resolve({ version: 2 });
              if (sql.includes("FROM telegram_credentials") && sql.includes("status = 'active'")) {
                return Promise.resolve(credentials.find((row) => row.status === "active") ?? null);
              }
              return Promise.resolve(null);
            },
            run() {
              if (sql.includes("INSERT INTO telegram_credentials")) {
                credentials.push({
                  activatedAt: null,
                  botTokenCiphertextB64: String(values[5]),
                  botTokenIvB64: String(values[6]),
                  credentialId: String(values[0]),
                  integrationId: String(values[2]),
                  keyVersion: String(values[4]),
                  shopId: String(values[1]),
                  status: "pending",
                  tokenFingerprint: String(values[9]),
                  version: Number(values[3]),
                  webhookSecretCiphertextB64: String(values[7]),
                  webhookSecretDigest: String(values[10]),
                  webhookSecretIvB64: String(values[8]),
                });
              }
              if (sql.includes("UPDATE telegram_credentials SET status = 'revoked'") && sql.includes("id != ?")) {
                const nextId = String(values[3]);
                for (const row of credentials) if (row.status === "active" && row.credentialId !== nextId) row.status = "revoked";
              }
              if (sql.includes("UPDATE telegram_credentials SET status = 'active'")) {
                const row = credentials.find((candidate) => candidate.credentialId === values[1]);
                if (row !== undefined) {
                  row.status = "active";
                  row.activatedAt = String(values[0]);
                }
              }
              if (sql.includes("UPDATE telegram_integrations SET status = ?")) {
                integration.status = String(values[0]);
                integration.webhookStatus = "verified";
                integration.activeCredentialId = String(values[1]);
                if (values[2] === 1) integration.lastHealthUpdateAt = null;
                integration.botId = String(values[3]);
                integration.botUsername = String(values[4]);
                integration.botDisplayName = String(values[5]);
                integration.pendingUpdateCount = Number(values[6]);
                integration.lastSafeErrorCode = typeof values[7] === "string" ? values[7] : null;
                integration.lastCheckedAt = String(values[8]);
              }
              return Promise.resolve({ meta: { changes: 1 } });
            },
          };
        },
      };
    },
    batch(statements: SqlStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const fetcher: typeof fetch = (request) => {
    const url = request instanceof Request ? request.url : request.toString();
    const method = url.slice(url.lastIndexOf("/") + 1);
    const result = method === "getMe"
      ? { first_name: "Replacement Bot", id: 987_654_321, is_bot: true, username: "replacement_bot" }
      : method === "getWebhookInfo"
        ? { allowed_updates: ["message", "callback_query"], max_connections: 20, pending_update_count: 0, url: `${API_ORIGIN}/webhooks/telegram/${integration.webhookPublicId}` }
        : true;
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
  };

  return { credentials, env: binding(database), fetcher, integration };
}

beforeEach(() => {
  membership.role = "owner";
});

afterEach(() => {
  for (const database of payOSDatabases.splice(0)) database.close();
});

describe("provider connection resumability", () => {
  it("reuses an errored Telegram credential and its original webhook secret", async () => {
    const runtime = await telegramRuntime();

    const first = await connectTelegram({
      botToken: TELEGRAM_BOT_TOKEN,
      env: runtime.env,
      fetcher: runtime.fetcher,
      replaceBot: false,
      requestId: "request-telegram-first",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });
    const second = await connectTelegram({
      botToken: TELEGRAM_BOT_TOKEN,
      env: runtime.env,
      fetcher: runtime.fetcher,
      replaceBot: false,
      requestId: "request-telegram-second",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    expect(first).toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(second).toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(runtime.credential).toMatchObject({ credentialId: "telegram-credential-a", status: "active", version: 4 });
    expect(runtime.webhookSecrets).toEqual([TELEGRAM_WEBHOOK_SECRET]);
    expect(runtime.getWebhookSetupCount()).toBe(1);
    expect(runtime.getCredentialInsertCount()).toBe(0);
    expect(runtime.sqlHistory.join("\n")).not.toContain("SELECT COALESCE(MAX(version)");
  });

  it("clears Telegram health evidence when the integration is disconnected", async () => {
    const runtime = await telegramRuntime();
    await connectTelegram({
      botToken: TELEGRAM_BOT_TOKEN,
      env: runtime.env,
      fetcher: runtime.fetcher,
      replaceBot: false,
      requestId: "request-telegram-connect",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });
    runtime.integration.lastHealthUpdateAt = "2026-07-26T00:00:00.000Z";

    await disconnectTelegram({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-telegram-disconnect",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });
    await expect(disconnectTelegram({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-telegram-disconnect-retry",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).resolves.toBeUndefined();

    expect(runtime.integration).toMatchObject({
      activeCredentialId: null,
      lastHealthUpdateAt: null,
      status: "disabled",
      webhookStatus: "disabled",
    });
    expect(runtime.credential.status).toBe("revoked");
  });

  it("clears Telegram health evidence when a different bot replaces the active bot", async () => {
    const runtime = await telegramReplacementRuntime();

    const result = await connectTelegram({
      botToken: TELEGRAM_REPLACEMENT_TOKEN,
      env: runtime.env,
      fetcher: runtime.fetcher,
      replaceBot: true,
      requestId: "request-telegram-replace",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    expect(result).toMatchObject({
      bot: { id: "987654321", username: "replacement_bot" },
      lastHealthUpdateAt: null,
      status: "active",
      webhookStatus: "verified",
    });
    expect(runtime.credentials).toHaveLength(2);
    expect(runtime.credentials.find((row) => row.credentialId === "telegram-credential-old")?.status).toBe("revoked");
    expect(runtime.credentials.find((row) => row.credentialId === runtime.integration.activeCredentialId)?.status).toBe("active");

    await expect(connectTelegram({
      botToken: TELEGRAM_REPLACEMENT_TOKEN,
      env: runtime.env,
      fetcher: runtime.fetcher,
      replaceBot: true,
      requestId: "request-telegram-replace-retry",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(runtime.credentials).toHaveLength(2);
  });

  it("clears Telegram health evidence when credentials rotate for the same bot", async () => {
    const runtime = await telegramReplacementRuntime({ sameBot: true });

    const result = await connectTelegram({
      botToken: TELEGRAM_REPLACEMENT_TOKEN,
      env: runtime.env,
      fetcher: runtime.fetcher,
      replaceBot: false,
      requestId: "request-telegram-token-rotation",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    expect(result).toMatchObject({
      bot: { id: "987654321", username: "replacement_bot" },
      lastHealthUpdateAt: null,
      status: "active",
      webhookStatus: "verified",
    });
    expect(runtime.credentials).toHaveLength(2);
  });

  it("retries Telegram setup with the retained encrypted credential", async () => {
    const runtime = await telegramRuntime();

    const result = await refreshTelegramHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-telegram-retry",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    expect(result).toMatchObject({ lastHealthUpdateAt: null, status: "active", webhookStatus: "verified" });
    expect(runtime.credential.status).toBe("active");
    expect(runtime.webhookSecrets).toEqual([TELEGRAM_WEBHOOK_SECRET]);
    expect(runtime.getCredentialInsertCount()).toBe(0);
    expect(JSON.stringify(result)).not.toContain(TELEGRAM_BOT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(TELEGRAM_WEBHOOK_SECRET);
  });

  it("reuses an errored PayOS credential and makes an active replay a no-op", async () => {
    const runtime = await payOSRuntime();
    const connect = (requestId: string) => connectPayOS({
      credentials: PAYOS_CREDENTIALS,
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId,
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    await expect(connect("request-payos-first")).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    await expect(connect("request-payos-second")).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });

    expect(runtime.credential).toMatchObject({ credentialId: "payos-credential-a", status: "active", version: 7 });
    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.getCredentialInsertCount()).toBe(0);
    expect(runtime.sqlHistory.join("\n")).not.toContain("SELECT COALESCE(MAX(version)");
  });

  it.each([
    { currentPeriodEnd: "2000-01-01T00:00:00.000Z", graceEndsAt: null, name: "expired active period", subscriptionState: "active" as const, expectedCode: "subscription_payment_required" },
    { currentPeriodEnd: "2000-01-01T00:00:00.000Z", graceEndsAt: null, name: "expired scheduled period", subscriptionState: "cancel_scheduled" as const, expectedCode: "subscription_payment_required" },
    { currentPeriodEnd: null, graceEndsAt: null, name: "missing active period", subscriptionState: "active" as const, expectedCode: "subscription_payment_required" },
    { graceEndsAt: null, name: "pending payment", subscriptionState: "pending_payment" as const, expectedCode: "subscription_payment_required" },
    { graceEndsAt: null, name: "expired trial", subscriptionState: "trialing" as const, trialEndsAt: "2000-01-01T00:00:00.000Z", expectedCode: "subscription_payment_required" },
    { graceEndsAt: "2099-01-01T00:00:00.000Z", name: "past due grace", subscriptionState: "past_due" as const, expectedCode: "provider_not_ready" },
    { graceEndsAt: "2099-01-01T00:00:00.000Z", name: "renewal grace", subscriptionState: "grace_period" as const, expectedCode: "provider_not_ready" },
    { graceEndsAt: "2000-01-01T00:00:00.000Z", name: "expired renewal grace", subscriptionState: "grace_period" as const, expectedCode: "subscription_grace_expired" },
    { graceEndsAt: null, name: "suspended", subscriptionState: "suspended" as const, expectedCode: "subscription_payment_required" },
  ])("blocks PayOS connection for a $name subscription", async ({ currentPeriodEnd, expectedCode, graceEndsAt, subscriptionState, trialEndsAt }) => {
    const runtime = await payOSRuntime({ active: true, currentPeriodEnd, graceEndsAt, subscriptionState, trialEndsAt });

    await expect(connectPayOS({
      credentials: PAYOS_ROTATED_CREDENTIALS,
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: `request-payos-block-${subscriptionState}`,
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).rejects.toMatchObject({ code: expectedCode });

    expect(runtime.getProviderCalls()).toBe(0);
    expect(runtime.getCredentialInsertCount()).toBe(0);
    expect(runtime.credential.status).toBe("active");
  });

  it("fails closed when the authoritative subscription row is missing", async () => {
    const runtime = await payOSRuntime({ active: true, withoutSubscription: true });

    await expect(connectPayOS({
      credentials: PAYOS_ROTATED_CREDENTIALS,
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-missing-subscription",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "subscription_payment_required" });

    expect(runtime.getProviderCalls()).toBe(0);
    expect(runtime.getCredentialInsertCount()).toBe(0);
    expect(runtime.sqlHistory.join("\n")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/u);
  });

  it("propagates subscription database failure before provider calls or writes", async () => {
    const runtime = await payOSRuntime({ active: true, subscriptionQueryFails: true });

    await expect(connectPayOS({
      credentials: PAYOS_ROTATED_CREDENTIALS,
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-subscription-db-failure",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).rejects.toThrow("subscription_query_failed");

    expect(runtime.getProviderCalls()).toBe(0);
    expect(runtime.getCredentialInsertCount()).toBe(0);
    expect(runtime.sqlHistory.join("\n")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/u);
  });
});

describe("PayOS health refresh", () => {
  it("retries pending setup with the retained encrypted credential", async () => {
    const runtime = await payOSRuntime({ pending: true });

    const result = await refreshPayOSHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-retry",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.getCredentialInsertCount()).toBe(0);
    expect(runtime.credential.status).toBe("active");
    expect(result).toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(JSON.stringify(result)).not.toContain(PAYOS_CREDENTIALS.apiKey);
    expect(JSON.stringify(result)).not.toContain(PAYOS_CREDENTIALS.checksumKey);
    expect(JSON.stringify(result)).not.toContain(PAYOS_CREDENTIALS.clientId);
  });

  it("blocks pending setup retry during renewal grace before calling PayOS", async () => {
    const runtime = await payOSRuntime({
      graceEndsAt: "2099-01-01T00:00:00.000Z",
      pending: true,
      subscriptionState: "past_due",
    });

    await expect(refreshPayOSHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-blocked-retry",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_not_ready" });

    expect(runtime.getProviderCalls()).toBe(0);
    expect(runtime.credential.status).toBe("pending");
  });

  it("keeps a failed pending retry sanitized and retryable", async () => {
    const runtime = await payOSRuntime({ pending: true, providerFails: true });

    const result = await refreshPayOSHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-retry-failed",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    expect(runtime.credential.status).toBe("error");
    expect(result).toMatchObject({ lastSafeErrorCode: "provider_verification_failed", status: "error", webhookStatus: "error" });
    expect(JSON.stringify(result)).not.toContain("sensitive provider description");
    expect(JSON.stringify(result)).not.toContain(PAYOS_CREDENTIALS.apiKey);
  });

  it("lets an owner reconfirm a stale webhook and records fresh health timestamps", async () => {
    const runtime = await payOSRuntime({ active: true });
    const previousCheckedAt = runtime.integration.lastCheckedAt;

    const result = await refreshPayOSHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-health",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    expect(runtime.getProviderCalls()).toBe(1);
    expect(result).toMatchObject({ lastSafeErrorCode: null, status: "active", webhookStatus: "verified" });
    expect(Date.parse(result.lastCheckedAt ?? "")).not.toBeNaN();
    expect(result.lastCheckedAt).not.toBe(previousCheckedAt);
    expect(result.lastWebhookVerifiedAt).toBe(result.lastCheckedAt);
  });

  it("blocks provider-mutating health refresh for a suspended subscription", async () => {
    const runtime = await payOSRuntime({ active: true, subscriptionState: "suspended" });

    await expect(refreshPayOSHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-blocked-health",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "subscription_payment_required" });

    expect(runtime.getProviderCalls()).toBe(0);
  });

  it("keeps integration reads and disconnect available while suspended", async () => {
    const runtime = await payOSRuntime({ active: true, subscriptionState: "suspended" });

    await expect(getPaymentIntegration({
      env: runtime.env,
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    await expect(disconnectPayOS({
      env: runtime.env,
      requestId: "request-payos-disconnect-suspended",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    })).resolves.toBeUndefined();

    expect(runtime.getProviderCalls()).toBe(0);
  });

  it("rejects a manager before loading credentials or calling PayOS", async () => {
    membership.role = "manager";
    const runtime = await payOSRuntime({ active: true });

    await expect(refreshPayOSHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-manager-health",
      shopPublicId: "shop-public-a",
      userId: "manager-a",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });

    expect(runtime.getProviderCalls()).toBe(0);
    expect(runtime.sqlHistory).toEqual([]);
  });

  it("stores only a safe provider code when webhook confirmation fails", async () => {
    const runtime = await payOSRuntime({ active: true, providerFails: true });
    const previousVerifiedAt = runtime.integration.lastWebhookVerifiedAt;

    const result = await refreshPayOSHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "request-payos-failed-health",
      shopPublicId: "shop-public-a",
      userId: "owner-a",
    });

    expect(result).toMatchObject({
      lastSafeErrorCode: "provider_verification_failed",
      lastWebhookVerifiedAt: previousVerifiedAt,
      status: "error",
      webhookStatus: "error",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive provider description");
  });
});
