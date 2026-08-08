import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hmacToken } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { encryptPayOSCredentials, type PayOSCredentials } from "../../src/lib/payments/crypto";
import { loadCredentialById, loadWebhookCredentials } from "../../src/lib/payments/credentials";
import { payOSProviderIdentityFingerprint } from "../../src/lib/payments/payos-admission";

vi.mock("../../src/lib/tenants/store", () => ({
  getShopForMember: vi.fn((input: { shopPublicId: string }) => Promise.resolve({
    row: {
      role: "owner",
      shop_id: input.shopPublicId.endsWith("0001") ? "shop-a" : "shop-b",
    },
    shop: {},
  })),
}));

import { connectPayOS, disconnectPayOS } from "../../src/lib/payments/integrations";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SHOP_A = "shop_00000000-0000-4000-8000-000000000001";
const SHOP_B = "shop_00000000-0000-4000-8000-000000000002";
const CHANNEL: PayOSCredentials = {
  apiKey: "shared-api-key",
  checksumKey: "shared-checksum-key",
  clientId: "shared-client-id",
};

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: SQLInputValue[] = [],
    private readonly beforeFirst?: FirstHook,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }), this.beforeFirst);
  }

  async first<T>(): Promise<T | null> {
    await this.beforeFirst?.(this);
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  all<T>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.sql).all(...this.values) as T[];
    return Promise.resolve({ results } as D1Result<T>);
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function applyMigrations(database: DatabaseSync, maximumMigration = Number.POSITIVE_INFINITY): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumMigration)
    .sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function seed(database: DatabaseSync): void {
  const now = "2026-08-09T00:00:00.000Z";
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES
      ('owner-a', 'owner-a@example.test', 'Owner A', 'active', ?, ?),
      ('owner-b', 'owner-b@example.test', 'Owner B', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', ?, 'shop-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?),
      ('shop-b', ?, 'shop-b', 'Shop B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(SHOP_A, now, now, SHOP_B, now, now);
}

type BatchHook = (statements: SqliteStatement[]) => void;
type FirstHook = (statement: SqliteStatement) => Promise<void>;

function bindings(database: DatabaseSync, hooks: { beforeBatch?: BatchHook; beforeFirst?: FirstHook } = {}): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    API_ORIGIN: "https://api.example.test",
    CREDENTIAL_KEK_V1: KEK,
    CREDENTIAL_KEY_VERSION: "v1",
    IDENTIFIER_HMAC_SECRET: "payos-concurrency-test-secret",
    PLATFORM_DB: {
      async batch(statements: D1PreparedStatement[]) {
        const sqliteStatements = statements as unknown as SqliteStatement[];
        hooks.beforeBatch?.(sqliteStatements);
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
        return new SqliteStatement(database, sql, [], hooks.beforeFirst) as unknown as D1PreparedStatement;
      },
    } as D1Database,
  } as unknown as AppBindings;
}

type ProviderCall = {
  reject: () => void;
  respond: (body: Record<string, unknown>, status: number) => void;
  webhookUrl: string;
};

class ControlledProvider {
  readonly calls: ProviderCall[] = [];
  private readonly waiters: Array<() => void> = [];

  readonly fetcher: typeof fetch = (_url, init) => new Promise<Response>((resolve, reject) => {
    if (typeof init?.body !== "string") throw new TypeError("provider_body_required");
    const body = JSON.parse(init.body) as { webhookUrl: string };
    this.calls.push({
      reject: () => {
        reject(new TypeError("simulated_response_loss"));
      },
      respond: (responseBody, status) => {
        resolve(new Response(JSON.stringify(responseBody), { status }));
      },
      webhookUrl: body.webhookUrl,
    });
    this.waiters.splice(0).forEach((notify) => {
      notify();
    });
  });

  async waitForCalls(count: number): Promise<void> {
    while (this.calls.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function accept(call: ProviderCall): void {
  call.respond({ code: "00", data: true }, 200);
}

function definitivelyReject(call: ProviderCall): void {
  call.respond({ code: "01", data: false }, 409);
}

function providerCall(provider: ControlledProvider, index: number): ProviderCall {
  const call = provider.calls[index];
  if (call === undefined) throw new Error("provider_call_missing");
  return call;
}

type Outcome =
  | { error: unknown; status: "rejected" }
  | { status: "fulfilled"; value: Awaited<ReturnType<typeof connectPayOS>> };

function outcome(promise: ReturnType<typeof connectPayOS>): Promise<Outcome> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error: unknown) => ({ error, status: "rejected" }),
  );
}

function webhookUrl(database: DatabaseSync, shopId: string): string {
  const row = database.prepare(`
    SELECT webhook_public_id AS webhookPublicId
    FROM payment_integrations WHERE shop_id = ?
  `).get(shopId) as { webhookPublicId: string };
  return `https://api.example.test/webhooks/payos/${row.webhookPublicId}`;
}

function unclaimedIdentityReadBarrier(): { beforeFirst: FirstHook; reads: () => number } {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    beforeFirst: async (statement) => {
      if (reads >= 2 || !statement.sql.includes("WHERE provider = 'payos' AND provider_identity_fingerprint = ?")) return;
      reads += 1;
      if (reads === 2) release();
      await gate;
    },
    reads: () => reads,
  };
}

describe("PayOS integration ownership concurrency", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seed(database);
  });

  afterEach(() => {
    database.close();
  });

  it("installs durable claim fencing and tenant-scoped credential guards", () => {
    const integrationColumns = database.prepare("PRAGMA table_info(payment_integrations)").all()
      .map((row) => (row as { name: string }).name);
    const credentialColumns = database.prepare("PRAGMA table_info(payment_credentials)").all()
      .map((row) => (row as { name: string }).name);
    expect(integrationColumns).toEqual(expect.arrayContaining([
      "provider_claim_generation",
      "provider_claim_nonce",
      "provider_claim_state",
      "provider_claim_target_fingerprint",
    ]));
    expect(credentialColumns).toContain("provider_claim_nonce");
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('index', 'trigger')
        AND (name LIKE '%payos_claim%' OR name = 'idx_payment_integrations_provider_claim_nonce')
      ORDER BY name
    `).all()).toEqual([
      { name: "idx_payment_integrations_provider_claim_nonce" },
      { name: "payment_credentials_payos_claim_fingerprint_update_guard" },
      { name: "payment_credentials_payos_claim_scope_insert_guard" },
      { name: "payment_credentials_payos_claim_scope_update_guard" },
      { name: "payment_integrations_payos_claim_fingerprint_update_guard" },
      { name: "payment_integrations_payos_claim_state_insert_guard" },
      { name: "payment_integrations_payos_claim_state_update_guard" },
    ]);
  });

  it("rejects the exact fingerprint-only claim SQL used by pre-fencing workers", () => {
    const rolling = new DatabaseSync(":memory:");
    try {
      applyMigrations(rolling, 88);
      seed(rolling);
      const now = "2026-08-09T00:00:00.000Z";
      const integrationId = "integration-old-worker-claim-00000001";
      const credentialId = "credential-old-worker-claim-00000001";
      const identityFingerprint = "identity-old-worker-fingerprint";
      const ownershipFingerprint = "credential-old-worker-ownership";
      rolling.prepare(`
        INSERT INTO payment_integrations (
          id, public_id, webhook_public_id, shop_id, provider, status,
          webhook_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'payos', 'pending', 'pending', ?, ?)
      `).run(
        integrationId,
        "public-old-worker-claim-00000001",
        "webhook-old-worker-claim-00000001",
        "shop-a",
        now,
        now,
      );
      rolling.prepare(`
        INSERT INTO payment_credentials (
          id, shop_id, integration_id, provider, status, version, key_version,
          client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
          api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
          credential_fingerprint, created_by_user_id, created_at
        ) VALUES (?, ?, ?, 'payos', 'pending', 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        credentialId,
        "shop-a",
        integrationId,
        "cipher",
        "iv",
        "cipher",
        "iv",
        "cipher",
        "iv",
        "credential-old-worker-fingerprint",
        "owner-a",
        now,
      );

      const oldIntegrationClaim = () => rolling.prepare(`
        UPDATE payment_integrations
        SET provider_identity_fingerprint = ?, updated_at = ?
        WHERE id = ? AND shop_id = ? AND provider = 'payos'
          AND (provider_identity_fingerprint IS NULL OR provider_identity_fingerprint = ?)
      `).run(identityFingerprint, now, integrationId, "shop-a", identityFingerprint);
      const oldCredentialClaim = () => rolling.prepare(`
        UPDATE payment_credentials
        SET provider_ownership_fingerprint = ?
        WHERE id = ? AND integration_id = ? AND shop_id = ?
          AND provider = 'payos'
          AND status IN ('pending', 'error', 'active')
          AND (provider_ownership_fingerprint IS NULL OR provider_ownership_fingerprint = ?)
      `).run(ownershipFingerprint, credentialId, integrationId, "shop-a", ownershipFingerprint);

      expect(oldIntegrationClaim).not.toThrow();
      expect(oldCredentialClaim).not.toThrow();
      expect(rolling.prepare(`
        SELECT provider_claim_nonce AS nonce, provider_claim_state AS claimState,
          provider_claim_target_fingerprint AS target
        FROM payment_integrations WHERE id = ? AND shop_id = 'shop-a'
      `).get(integrationId)).toEqual({ claimState: "idle", nonce: null, target: null });

      rolling.exec(readFileSync(join(
        process.cwd(),
        "migrations/0089_payos_provider_claim_compatibility.sql",
      ), "utf8"));
      const quarantined = rolling.prepare(`
        SELECT provider_claim_nonce AS nonce, provider_claim_state AS claimState,
          provider_claim_target_fingerprint AS target
        FROM payment_integrations WHERE id = ? AND shop_id = 'shop-a'
      `).get(integrationId) as { claimState: string; nonce: string; target: string | null };
      expect(quarantined).toMatchObject({ claimState: "quarantined", target: null });
      expect(rolling.prepare(`
        SELECT provider_claim_nonce AS nonce
        FROM payment_credentials WHERE id = ? AND shop_id = 'shop-a'
      `).get(credentialId)).toEqual({ nonce: quarantined.nonce });

      expect(oldIntegrationClaim).toThrow(/payos_provider_identity_claim_unfenced/u);
      expect(oldCredentialClaim).toThrow(/payos_provider_credential_claim_unfenced/u);
    } finally {
      rolling.close();
    }
  });

  it("migrates unverifiable legacy claims into durable quarantine", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      applyMigrations(legacy, 87);
      seed(legacy);
      const now = "2026-08-09T00:00:00.000Z";
      legacy.prepare(`
        INSERT INTO payment_integrations (
          id, public_id, webhook_public_id, shop_id, provider, status,
          webhook_status, provider_identity_fingerprint, created_at, updated_at
        ) VALUES (
          'integration-legacy-claim-000000000001', 'public-legacy-claim', 'webhook-legacy-claim',
          'shop-a', 'payos', 'error', 'error', 'legacy-identity-claim', ?, ?
        )
      `).run(now, now);
      legacy.prepare(`
        INSERT INTO payment_credentials (
          id, shop_id, integration_id, provider, status, version, key_version,
          client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
          api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
          credential_fingerprint, provider_ownership_fingerprint,
          created_by_user_id, created_at
        ) VALUES (
          'credential-legacy-claim', 'shop-a', 'integration-legacy-claim-000000000001', 'payos',
          'error', 1, 'v1', 'cipher', 'iv', 'cipher', 'iv', 'cipher', 'iv',
          'credential-legacy-fingerprint', 'provider-legacy-fingerprint', 'owner-a', ?
        )
      `).run(now);

      legacy.exec(readFileSync(join(process.cwd(), "migrations/0088_payos_provider_claim_fencing.sql"), "utf8"));

      const integration = legacy.prepare(`
        SELECT provider_claim_nonce AS nonce, provider_claim_state AS claimState,
          provider_claim_target_fingerprint AS target
        FROM payment_integrations WHERE id = 'integration-legacy-claim-000000000001'
      `).get() as { claimState: string; nonce: string; target: string | null };
      expect(integration).toMatchObject({ claimState: "quarantined", target: null });
      expect(integration.nonce).toMatch(/^legacy_[A-Za-z0-9_]+$/u);
      expect(legacy.prepare(`
        SELECT provider_claim_nonce AS nonce
        FROM payment_credentials WHERE id = 'credential-legacy-claim'
      `).get()).toEqual({ nonce: integration.nonce });
    } finally {
      legacy.close();
    }
  });

  it("lets only the owning tenant reconcile an 0088 targetless legacy quarantine", async () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      applyMigrations(legacy, 87);
      seed(legacy);
      const integrationId = "integration-legacy-recovery-000000001";
      const credentialId = "credential-legacy-recovery-000000001";
      const now = "2026-08-09T00:00:00.000Z";
      const encrypted = await encryptPayOSCredentials(CHANNEL, {
        credentialId,
        hmacSecret: "payos-concurrency-test-secret",
        integrationId,
        kek: KEK,
        keyVersion: "v1",
        shopId: "shop-a",
      });
      const env = bindings(legacy);
      const providerIdentityFingerprint = await payOSProviderIdentityFingerprint(env, CHANNEL);
      const providerOwnershipFingerprint = await hmacToken(
        "payos-concurrency-test-secret",
        "payos-provider-credential:v1",
        `${CHANNEL.clientId}\0${CHANNEL.apiKey}\0${CHANNEL.checksumKey}`,
      );
      legacy.prepare(`
        INSERT INTO payment_integrations (
          id, public_id, webhook_public_id, shop_id, provider, status,
          webhook_status, provider_identity_fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, 'shop-a', 'payos', 'error', 'error', ?, ?, ?)
      `).run(
        integrationId,
        "public-legacy-recovery-000000001",
        "webhook-legacy-recovery-000000001",
        providerIdentityFingerprint,
        now,
        now,
      );
      legacy.prepare(`
        INSERT INTO payment_credentials (
          id, shop_id, integration_id, provider, status, version, key_version,
          client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
          api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
          credential_fingerprint, provider_ownership_fingerprint,
          created_by_user_id, created_at
        ) VALUES (?, 'shop-a', ?, 'payos', 'error', 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, 'owner-a', ?)
      `).run(
        credentialId,
        integrationId,
        encrypted.clientIdCiphertextB64,
        encrypted.clientIdIvB64,
        encrypted.apiKeyCiphertextB64,
        encrypted.apiKeyIvB64,
        encrypted.checksumKeyCiphertextB64,
        encrypted.checksumKeyIvB64,
        encrypted.fingerprint,
        providerOwnershipFingerprint,
        now,
      );
      legacy.exec(readFileSync(join(process.cwd(), "migrations/0088_payos_provider_claim_fencing.sql"), "utf8"));
      legacy.exec(readFileSync(join(process.cwd(), "migrations/0089_payos_provider_claim_compatibility.sql"), "utf8"));

      const quarantine = legacy.prepare(`
        SELECT provider_claim_nonce AS nonce, provider_claim_state AS claimState,
          provider_claim_target_fingerprint AS target
        FROM payment_integrations WHERE id = ? AND shop_id = 'shop-a'
      `).get(integrationId) as { claimState: string; nonce: string; target: string | null };
      expect(quarantine).toMatchObject({ claimState: "quarantined", target: null });

      let crossTenantProviderCalls = 0;
      await expect(connectPayOS({
        credentials: CHANNEL,
        env,
        fetcher: () => {
          crossTenantProviderCalls += 1;
          return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
        },
        requestId: "request-legacy-cross-tenant",
        shopPublicId: SHOP_B,
        userId: "owner-b",
      })).rejects.toMatchObject({ code: "credential_already_connected", status: 409 });
      expect(crossTenantProviderCalls).toBe(0);

      let ownerProviderCalls = 0;
      await expect(connectPayOS({
        credentials: CHANNEL,
        env,
        fetcher: () => {
          ownerProviderCalls += 1;
          return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
        },
        requestId: "request-legacy-owner-recovery",
        shopPublicId: SHOP_A,
        userId: "owner-a",
      })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
      expect(ownerProviderCalls).toBe(1);
      expect(legacy.prepare(`
        SELECT active_credential_id AS activeCredentialId,
          provider_claim_nonce AS nonce, provider_claim_state AS claimState,
          provider_claim_target_fingerprint AS target,
          provider_identity_fingerprint AS identity, status, webhook_status AS webhookStatus
        FROM payment_integrations WHERE id = ? AND shop_id = 'shop-a'
      `).get(integrationId)).toEqual({
        activeCredentialId: credentialId,
        claimState: "idle",
        identity: providerIdentityFingerprint,
        nonce: null,
        status: "active",
        target: null,
        webhookStatus: "verified",
      });
      expect(legacy.prepare(`
        SELECT provider_claim_nonce AS nonce,
          provider_ownership_fingerprint AS ownership, status
        FROM payment_credentials WHERE id = ? AND shop_id = 'shop-a'
      `).get(credentialId)).toEqual({
        nonce: null,
        ownership: providerOwnershipFingerprint,
        status: "active",
      });
    } finally {
      legacy.close();
    }
  });

  it.each([
    {
      first: { publicId: SHOP_A, shopId: "shop-a", userId: "owner-a" },
      name: "the first provider response arrives first",
      responseOrder: [0, 1],
      second: { publicId: SHOP_B, shopId: "shop-b", userId: "owner-b" },
    },
    {
      first: { publicId: SHOP_B, shopId: "shop-b", userId: "owner-b" },
      name: "the second provider response arrives first",
      responseOrder: [1, 0],
      second: { publicId: SHOP_A, shopId: "shop-a", userId: "owner-a" },
    },
  ])("reserves identical credentials before redirecting the webhook when $name", async ({ first, responseOrder, second }) => {
    const barrier = unclaimedIdentityReadBarrier();
    const env = bindings(database, { beforeFirst: barrier.beforeFirst });
    const provider = new ControlledProvider();
    const firstResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: `request-${first.shopId}`,
      shopPublicId: first.publicId,
      userId: first.userId,
    }));
    const secondResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: `request-${second.shopId}`,
      shopPublicId: second.publicId,
      userId: second.userId,
    }));
    const phase = await Promise.race([
      provider.waitForCalls(2).then(() => "both-called" as const),
      firstResult.then(() => "one-settled" as const),
      secondResult.then(() => "one-settled" as const),
    ]);

    if (phase === "both-called") {
      for (const index of responseOrder) {
        const call = provider.calls[index];
        if (call !== undefined) accept(call);
        await (index === 0 ? firstResult : secondResult);
      }
    } else {
      const call = provider.calls[0];
      if (call !== undefined) accept(call);
    }

    const [firstOutcome, secondOutcome] = await Promise.all([firstResult, secondResult]);
    const successfulShop = firstOutcome.status === "fulfilled" ? first : second;
    const rejectedOutcome = firstOutcome.status === "rejected" ? firstOutcome : secondOutcome;
    expect([firstOutcome.status, secondOutcome.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejectedOutcome).toMatchObject({ error: { code: "credential_already_connected", status: 409 }, status: "rejected" });
    expect(provider.calls.map((call) => call.webhookUrl)).toEqual([webhookUrl(database, successfulShop.shopId)]);
    expect(barrier.reads()).toBe(2);
    expect(database.prepare(`
      SELECT shop_id AS shopId FROM payment_integrations
      WHERE provider_identity_fingerprint IS NOT NULL
    `).all()).toEqual([{ shopId: successfulShop.shopId }]);
  });

  it("releases provisional ownership after provider rejection so another shop can connect", async () => {
    const env = bindings(database);
    let failedCalls = 0;
    const rejectedProvider: typeof fetch = () => {
      failedCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "01", data: false }), { status: 409 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: rejectedProvider,
      requestId: "request-rejected",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_verification_failed", status: 409 });

    expect(database.prepare(`
      SELECT provider_claim_nonce AS nonce, provider_claim_state AS claimState,
        provider_identity_fingerprint AS identity, status
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ claimState: "idle", identity: null, nonce: null, status: "error" });
    expect(database.prepare(`
      SELECT provider_claim_nonce AS nonce, provider_ownership_fingerprint AS ownership, status
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get()).toEqual({ nonce: null, ownership: null, status: "error" });

    let successfulCalls = 0;
    const acceptedProvider: typeof fetch = () => {
      successfulCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: acceptedProvider,
      requestId: "request-retry-other-shop",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    expect({ failedCalls, successfulCalls }).toEqual({ failedCalls: 1, successfulCalls: 1 });
  });

  it.each([
    {
      createResponse: (): Response => new Response(JSON.stringify({ code: "01", data: false }), { status: 503 }),
      name: "a provider 5xx",
    },
    {
      createResponse: (): Promise<Response> => Promise.reject(new TypeError("response_lost_after_dispatch")),
      name: "a network failure",
    },
  ])("quarantines ownership after $name and blocks a delayed cross-shop webhook overwrite", async ({ createResponse }) => {
    const env = bindings(database);
    let firstWebhookUrl = "";
    const ambiguousProvider: typeof fetch = (_url, init) => {
      if (typeof init?.body !== "string") throw new TypeError("provider_body_required");
      firstWebhookUrl = (JSON.parse(init.body) as { webhookUrl: string }).webhookUrl;
      return Promise.resolve(createResponse());
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: ambiguousProvider,
      requestId: "request-ambiguous",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_verification_failed", status: 503 });

    expect(database.prepare(`
      SELECT provider_claim_nonce IS NOT NULL AS claimed,
        provider_claim_state AS claimState,
        provider_identity_fingerprint IS NOT NULL AS identityOwned,
        last_safe_error_code AS safeCode, status
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({
      claimed: 1,
      claimState: "ambiguous",
      identityOwned: 1,
      safeCode: "provider_verification_unknown",
      status: "error",
    });
    const integration = database.prepare(`
      SELECT webhook_public_id AS webhookPublicId FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get() as { webhookPublicId: string };
    await expect(loadWebhookCredentials(env, integration.webhookPublicId)).resolves.toEqual([]);

    let secondProviderCalls = 0;
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: () => {
        secondProviderCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
      },
      requestId: "request-cross-shop-after-ambiguous",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    })).rejects.toMatchObject({ code: "credential_already_connected", status: 409 });

    const delayedProviderWebhook = firstWebhookUrl;
    expect(secondProviderCalls).toBe(0);
    expect(delayedProviderWebhook).toBe(webhookUrl(database, "shop-a"));
  });

  it("lets the same shop explicitly reconcile an ambiguous same-target claim", async () => {
    const env = bindings(database);
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: () => Promise.reject(new TypeError("response_lost_after_dispatch")),
      requestId: "request-ambiguous-owner",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_verification_failed", status: 503 });

    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: () => Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 })),
      requestId: "request-reconcile-owner",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });

    expect(database.prepare(`
      SELECT provider_claim_nonce AS nonce, provider_claim_state AS claimState,
        provider_identity_fingerprint IS NOT NULL AS identityOwned, status
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ claimState: "idle", identityOwned: 1, nonce: null, status: "active" });
  });

  it("fences stale same-shop rejection before the newer attempt activates", async () => {
    const env = bindings(database);
    const provider = new ControlledProvider();
    const staleResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: "request-stale-rejection",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    }));
    await provider.waitForCalls(1);
    const currentResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: "request-current-success",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    }));
    await provider.waitForCalls(2);

    definitivelyReject(providerCall(provider, 0));
    await staleResult;
    accept(providerCall(provider, 1));
    const [stale, current] = await Promise.all([staleResult, currentResult]);

    expect(stale).toMatchObject({ error: { code: "provider_verification_failed" }, status: "rejected" });
    expect(current).toMatchObject({ status: "fulfilled", value: { status: "active", webhookStatus: "verified" } });
    expect(database.prepare(`
      SELECT provider_identity_fingerprint IS NOT NULL AS identityOwned,
        provider_claim_nonce AS nonce, provider_claim_state AS claimState
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ claimState: "idle", identityOwned: 1, nonce: null });
    expect(database.prepare(`
      SELECT provider_ownership_fingerprint IS NOT NULL AS credentialOwned, status
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get()).toEqual({ credentialOwned: 1, status: "active" });
  });

  it("fences stale same-shop activation after a newer claim supersedes it", async () => {
    const env = bindings(database);
    const provider = new ControlledProvider();
    const staleResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: "request-stale-success",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    }));
    await provider.waitForCalls(1);
    const currentResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: "request-current-success",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    }));
    await provider.waitForCalls(2);

    accept(providerCall(provider, 1));
    const current = await currentResult;
    accept(providerCall(provider, 0));
    const stale = await staleResult;

    expect(stale).toMatchObject({ error: { code: "payment_integration_conflict", status: 409 }, status: "rejected" });
    expect(current).toMatchObject({ status: "fulfilled", value: { status: "active", webhookStatus: "verified" } });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'payos.credentials_connected'
    `).get()).toEqual({ count: 1 });
  });

  it("excludes superseded pending credentials from webhook verification candidates", async () => {
    const env = bindings(database);
    const provider = new ControlledProvider();
    const firstResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: "request-first-credential",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    }));
    await provider.waitForCalls(1);
    const rotatedCredentials = { ...CHANNEL, apiKey: "rotated-api-key", checksumKey: "rotated-checksum-key" };
    const secondResult = outcome(connectPayOS({
      credentials: rotatedCredentials,
      env,
      fetcher: provider.fetcher,
      requestId: "request-second-credential",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    }));
    await provider.waitForCalls(2);

    const integration = database.prepare(`
      SELECT webhook_public_id AS webhookPublicId FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get() as { webhookPublicId: string };
    const candidates = await loadWebhookCredentials(env, integration.webhookPublicId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.row.version).toBe(2);

    definitivelyReject(providerCall(provider, 0));
    accept(providerCall(provider, 1));
    await Promise.all([firstResult, secondResult]);
  });

  it("preserves verified disconnected ownership and grace when reconnect is rejected", async () => {
    const env = bindings(database);
    const acceptedProvider: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
    await connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: acceptedProvider,
      requestId: "request-connect-before-disconnect",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    });
    await disconnectPayOS({ env, requestId: "request-disconnect", shopPublicId: SHOP_A, userId: "owner-a" });
    const before = database.prepare(`
      SELECT active_credential_id AS activeCredentialId,
        provider_identity_fingerprint AS identity, status, webhook_status AS webhookStatus
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get();
    const credentialBefore = database.prepare(`
      SELECT id, provider_ownership_fingerprint AS ownership, status
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get() as { id: string; ownership: string; status: string };

    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: () => Promise.resolve(new Response(JSON.stringify({ code: "01", data: false }), { status: 409 })),
      requestId: "request-reconnect-rejected",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_verification_failed", status: 409 });

    expect(database.prepare(`
      SELECT active_credential_id AS activeCredentialId,
        provider_identity_fingerprint AS identity, status, webhook_status AS webhookStatus
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual(before);
    expect(database.prepare(`
      SELECT id, provider_ownership_fingerprint AS ownership, status
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get()).toEqual(credentialBefore);
    await expect(loadCredentialById(env, credentialBefore.id, "shop-a"))
      .resolves.toMatchObject({ row: { status: "grace" } });
  });

  it("retains provisional ownership when release compensation fails and blocks another provider write", async () => {
    let compensationAttempts = 0;
    const env = bindings(database, {
      beforeBatch: (statements) => {
        if (statements.some((statement) => statement.sql.includes("provider_identity_fingerprint = CASE"))) {
          compensationAttempts += 1;
          throw new Error("injected_compensation_failure");
        }
      },
    });
    let failedCalls = 0;
    const rejectedProvider: typeof fetch = () => {
      failedCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "01", data: false }), { status: 409 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: rejectedProvider,
      requestId: "request-compensation-failure",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_verification_failed", status: 409 });

    expect(compensationAttempts).toBe(1);
    expect(database.prepare(`
      SELECT provider_claim_state AS claimState,
        provider_identity_fingerprint IS NOT NULL AS identityOwned, status
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ claimState: "in_flight", identityOwned: 1, status: "pending" });
    expect(database.prepare(`
      SELECT provider_ownership_fingerprint IS NOT NULL AS credentialOwned, status
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get()).toEqual({ credentialOwned: 1, status: "pending" });

    let secondProviderCalls = 0;
    const secondProvider: typeof fetch = () => {
      secondProviderCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: secondProvider,
      requestId: "request-blocked-other-shop",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    })).rejects.toMatchObject({ code: "credential_already_connected", status: 409 });
    expect({ failedCalls, secondProviderCalls }).toEqual({ failedCalls: 1, secondProviderCalls: 0 });
  });
});
