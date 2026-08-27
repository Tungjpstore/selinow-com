import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import type { PayOSCredentials } from "../../src/lib/payments/crypto";
import { payOSProviderIdentityFingerprint } from "../../src/lib/payments/payos-admission";

vi.mock("../../src/lib/tenants/store", () => ({
  getShopForMember: vi.fn((input: { shopPublicId: string; userId: string }) => {
    const shopId = input.shopPublicId.endsWith("0001") ? "shop-a" : "shop-b";
    return Promise.resolve({ row: { role: "owner", shop_id: shopId }, shop: {} });
  }),
}));

import { connectPayOS, disconnectPayOS } from "../../src/lib/payments/integrations";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SHOP_A = "shop_00000000-0000-4000-8000-000000000001";
const SHOP_B = "shop_00000000-0000-4000-8000-000000000002";
const CHANNEL_A: PayOSCredentials = {
  apiKey: "channel-a-api-key",
  checksumKey: "channel-a-checksum-key",
  clientId: "channel-a-client-id",
};

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }));
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
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

type PayOSTestBindings = AppBindings & { PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT?: string };

function bindings(database: DatabaseSync): PayOSTestBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    API_ORIGIN: "https://api.example.test",
    CREDENTIAL_KEK_V1: KEK,
    CREDENTIAL_KEY_VERSION: "v1",
    IDENTIFIER_HMAC_SECRET: "payment-provider-ownership-test-secret",
    PLATFORM_DB: {
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
    } as D1Database,
  } as unknown as AppBindings;
}

function seed(database: DatabaseSync): void {
  const now = "2026-07-26T04:00:00.000Z";
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
  if (database.prepare("SELECT id FROM plans WHERE id = 'plan_starter_v1'").get() !== undefined) {
    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, current_period_end, created_at, updated_at
      ) VALUES
        ('subscription-a', 'shop-a', 'plan_starter_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?),
        ('subscription-b', 'shop-b', 'plan_starter_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)
    `).run(now, now, now, now);
  }
}

function provider(fetchCount: { value: number }): typeof fetch {
  return (_request, init) => {
    fetchCount.value += 1;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { webhookUrl: string };
    return Promise.resolve(Response.json({ code: "00", data: {
      accountName: "Selinow Test",
      accountNumber: "0000006797",
      name: "Selinow Staging UAT",
      shortName: "SELINOW",
      webhookUrl: body.webhookUrl,
    } }));
  };
}

describe("PayOS provider identity ownership", () => {
  let database: DatabaseSync;
  let env: PayOSTestBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seed(database);
    env = bindings(database);
  });

  afterEach(() => {
    database.close();
  });

  it("rejects cross-shop reuse before credential persistence or a second provider call", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-owner-a", shopPublicId: SHOP_A, userId: "owner-a" });

    await expect(connectPayOS({
      credentials: CHANNEL_A,
      env,
      fetcher,
      requestId: "request-owner-b",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    })).rejects.toMatchObject({ code: "credential_already_connected", status: 409 });

    expect(fetchCount.value).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_credentials").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_integrations WHERE provider_identity_fingerprint IS NOT NULL").get())
      .toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT status, webhook_status AS webhookStatus,
        provider_account_fingerprint IS NOT NULL AS accountVerified
      FROM payment_provider_connections
      WHERE shop_id = 'shop-a' AND legacy_payos_integration_id = (
        SELECT id FROM payment_integrations WHERE shop_id = 'shop-a'
      )
    `).get()).toEqual({ accountVerified: 1, status: "active", webhookStatus: "verified" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM payment_provider_connection_capabilities
      WHERE shop_id = 'shop-a' AND effective_enabled = 1
    `).get()).toEqual({ count: 4 });
  });

  it("rejects rotated cross-shop credentials before redirecting the verified channel webhook", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-owner-a", shopPublicId: SHOP_A, userId: "owner-a" });

    await expect(connectPayOS({
      credentials: {
        ...CHANNEL_A,
        apiKey: "rotated-api-key-for-shop-b",
        checksumKey: "rotated-checksum-key-for-shop-b",
      },
      env,
      fetcher,
      requestId: "request-owner-b-rotated",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    })).rejects.toMatchObject({ code: "credential_already_connected", status: 409 });

    expect(fetchCount.value).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_credentials WHERE shop_id = 'shop-b'").get())
      .toEqual({ count: 0 });
  });

  it("rejects a different channel identity before redirecting an existing shop webhook", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-owner-a", shopPublicId: SHOP_A, userId: "owner-a" });

    await expect(connectPayOS({
      credentials: {
        apiKey: "different-api-key",
        checksumKey: "different-checksum-key",
        clientId: "different-client-id",
      },
      env,
      fetcher,
      requestId: "request-different-channel",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "credential_channel_mismatch", status: 409 });

    expect(fetchCount.value).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_credentials WHERE shop_id = 'shop-a'").get())
      .toEqual({ count: 1 });
  });

  it("fails staging connection closed until the controlled channel is explicitly attested", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    env.APP_ENV = "staging";

    await expect(connectPayOS({
      credentials: CHANNEL_A,
      env,
      fetcher,
      requestId: "request-staging-unattested",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "payment_provider_environment_not_admitted", status: 409 });

    expect(fetchCount.value).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_credentials").get()).toEqual({ count: 0 });

    env.PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT = await payOSProviderIdentityFingerprint(env, CHANNEL_A);
    await expect(connectPayOS({
      credentials: CHANNEL_A,
      env,
      fetcher,
      requestId: "request-staging-attested",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(fetchCount.value).toBe(1);
  });

  it("retains channel ownership across same-shop secret rotation and disconnect", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    const rotatedChannel = { ...CHANNEL_A, apiKey: "rotated-api-key", checksumKey: "rotated-checksum-key" };
    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-connect", shopPublicId: SHOP_A, userId: "owner-a" });
    await connectPayOS({
      credentials: rotatedChannel,
      env,
      fetcher,
      requestId: "request-rotate",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    });
    const rotatedGeneration = database.prepare("SELECT provider_claim_generation AS generation FROM payment_integrations WHERE shop_id = 'shop-a'").get();
    await expect(connectPayOS({
      credentials: rotatedChannel,
      env,
      fetcher,
      requestId: "request-rotate-retry",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(database.prepare("SELECT provider_claim_generation AS generation FROM payment_integrations WHERE shop_id = 'shop-a'").get()).toEqual(rotatedGeneration);
    await disconnectPayOS({ env, requestId: "request-disconnect", shopPublicId: SHOP_A, userId: "owner-a" });
    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-reconnect", shopPublicId: SHOP_A, userId: "owner-a" });

    await expect(connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-steal", shopPublicId: SHOP_B, userId: "owner-b" }))
      .rejects.toMatchObject({ code: "credential_already_connected", status: 409 });
    expect(fetchCount.value).toBe(3);
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_credentials WHERE shop_id = 'shop-a'").get())
      .toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_credentials WHERE shop_id = 'shop-a' AND status = 'active'").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_credentials WHERE shop_id = 'shop-b'").get())
      .toEqual({ count: 0 });
  });

  it("allows an owner to replace the PayOS channel after an explicit disconnect", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    const replacementChannel: PayOSCredentials = {
      apiKey: "replacement-api-key",
      checksumKey: "replacement-checksum-key",
      clientId: "replacement-client-id",
    };

    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-original", shopPublicId: SHOP_A, userId: "owner-a" });
    await disconnectPayOS({ env, requestId: "request-explicit-disconnect", shopPublicId: SHOP_A, userId: "owner-a" });
    await expect(connectPayOS({
      credentials: replacementChannel,
      env,
      fetcher,
      requestId: "request-replacement",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });

    expect(fetchCount.value).toBe(2);
    const replacementIdentity = await payOSProviderIdentityFingerprint(env, replacementChannel);
    expect(database.prepare(`
      SELECT status, provider_identity_fingerprint IS NOT NULL AS identityOwned
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ identityOwned: 1, status: "active" });
    expect(database.prepare(`
      SELECT provider_account_fingerprint AS accountFingerprint, status
      FROM payment_provider_connections WHERE shop_id = 'shop-a'
    `).get()).toEqual({ accountFingerprint: replacementIdentity, status: "active" });

    await expect(connectPayOS({
      credentials: replacementChannel,
      env,
      fetcher,
      requestId: "request-replacement-cross-shop",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    })).rejects.toMatchObject({ code: "credential_already_connected", status: 409 });
  });

  it("makes a settled disconnect retry a no-op without advancing the provider generation", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-connect", shopPublicId: SHOP_A, userId: "owner-a" });
    await disconnectPayOS({ env, requestId: "request-disconnect", shopPublicId: SHOP_A, userId: "owner-a" });
    const settled = database.prepare(`
      SELECT active_credential_id AS activeCredentialId,
        provider_claim_generation AS generation,
        provider_claim_nonce AS nonce,
        provider_claim_state AS claimState,
        provider_claim_target_fingerprint AS targetFingerprint,
        status, webhook_status AS webhookStatus
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get();

    await expect(disconnectPayOS({
      env,
      requestId: "request-disconnect-retry",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).resolves.toBeUndefined();

    expect(database.prepare(`
      SELECT active_credential_id AS activeCredentialId,
        provider_claim_generation AS generation,
        provider_claim_nonce AS nonce,
        provider_claim_state AS claimState,
        provider_claim_target_fingerprint AS targetFingerprint,
        status, webhook_status AS webhookStatus
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual(settled);
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE shop_id = 'shop-a' AND action = 'payos.disconnected'").get()).toEqual({ count: 1 });
  });

  it("does not let an unverified client-id claim block legitimate credentials", async () => {
    const fetchCount = { value: 0 };
    const failingFetcher: typeof fetch = () => {
      fetchCount.value += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "01", desc: "credentials rejected" }), { status: 409 }));
    };
    await expect(connectPayOS({ credentials: CHANNEL_A, env, fetcher: failingFetcher, requestId: "request-failed", shopPublicId: SHOP_A, userId: "owner-a" }))
      .rejects.toMatchObject({ code: "provider_verification_failed", status: 409 });
    expect(fetchCount.value).toBe(1);
    expect(database.prepare("SELECT status, provider_identity_fingerprint AS identity FROM payment_integrations WHERE shop_id = 'shop-a'").get())
      .toEqual({ identity: null, status: "error" });
    expect(database.prepare("SELECT status, provider_ownership_fingerprint AS ownership FROM payment_credentials WHERE shop_id = 'shop-a'").get())
      .toEqual({ ownership: null, status: "error" });

    const successfulFetcher = provider(fetchCount);
    await expect(connectPayOS({
      credentials: {
        ...CHANNEL_A,
        apiKey: "legitimate-rotated-api-key",
        checksumKey: "legitimate-rotated-checksum-key",
      },
      env,
      fetcher: successfulFetcher,
      requestId: "request-legitimate-owner",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    }))
      .resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(fetchCount.value).toBe(2);
    expect(database.prepare(`
      SELECT shop_id AS shopId
      FROM payment_integrations
      WHERE provider_identity_fingerprint IS NOT NULL
    `).all()).toEqual([{ shopId: "shop-b" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_credentials WHERE shop_id = 'shop-a' AND status = 'error'").get())
      .toEqual({ count: 1 });
  });

  it("reconciles an ambiguously quarantined same-shop credential without releasing ownership", async () => {
    const fetchCount = { value: 0 };
    const failingFetcher: typeof fetch = () => {
      fetchCount.value += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "01" }), { status: 503 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL_A,
      env,
      fetcher: failingFetcher,
      requestId: "request-failed",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_verification_failed", status: 503 });
    expect(database.prepare(`
      SELECT provider_claim_nonce IS NOT NULL AS claimed,
        provider_claim_state AS claimState,
        provider_identity_fingerprint IS NOT NULL AS owned
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ claimed: 1, claimState: "ambiguous", owned: 1 });
    expect(database.prepare(`
      SELECT provider_claim_nonce IS NOT NULL AS claimed,
        provider_ownership_fingerprint IS NOT NULL AS owned, status
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get()).toEqual({ claimed: 1, owned: 1, status: "error" });

    await expect(connectPayOS({
      credentials: CHANNEL_A,
      env,
      fetcher: provider(fetchCount),
      requestId: "request-retry",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });

    expect(fetchCount.value).toBe(2);
    expect(database.prepare(`
      SELECT status, provider_ownership_fingerprint IS NOT NULL AS owned
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get()).toEqual({ owned: 1, status: "active" });
    expect(database.prepare(`
      SELECT status, provider_identity_fingerprint IS NOT NULL AS owned
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ owned: 1, status: "active" });
  });

  it("fails closed when a legacy credential has no provider ownership fingerprint", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-legacy-seed", shopPublicId: SHOP_A, userId: "owner-a" });
    database.prepare("UPDATE payment_credentials SET provider_ownership_fingerprint = NULL WHERE shop_id = 'shop-a'").run();

    await expect(connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-legacy-retry", shopPublicId: SHOP_A, userId: "owner-a" }))
      .rejects.toMatchObject({ code: "payment_not_configured", status: 409 });
    expect(fetchCount.value).toBe(1);
    expect(database.prepare("SELECT provider_ownership_fingerprint AS ownership FROM payment_credentials WHERE shop_id = 'shop-a'").get())
      .toEqual({ ownership: null });
  });

  it("allows different PayOS channel identities for different shops", async () => {
    const fetchCount = { value: 0 };
    const fetcher = provider(fetchCount);
    await connectPayOS({ credentials: CHANNEL_A, env, fetcher, requestId: "request-channel-a", shopPublicId: SHOP_A, userId: "owner-a" });
    await connectPayOS({
      credentials: { apiKey: "channel-b-api-key", checksumKey: "channel-b-checksum-key", clientId: "channel-b-client-id" },
      env,
      fetcher,
      requestId: "request-channel-b",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    });

    expect(fetchCount.value).toBe(2);
    expect(database.prepare("SELECT COUNT(DISTINCT provider_identity_fingerprint) AS count FROM payment_integrations").get())
      .toEqual({ count: 2 });
  });
});

describe("PayOS identity claim hardening migration", () => {
  it("releases only unverified legacy claims and preserves disconnected ownership", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database, 34);
      seed(database);
      const now = "2026-07-29T06:00:00.000Z";
      database.prepare(`
        INSERT INTO payment_integrations (
          id, public_id, webhook_public_id, shop_id, provider, status,
          webhook_status, created_at, updated_at, provider_identity_fingerprint
        ) VALUES
          ('integration-unverified', 'public-unverified', 'webhook-unverified',
            'shop-a', 'payos', 'error', 'error', ?, ?, 'unverified-client-claim'),
          ('integration-disconnected', 'public-disconnected', 'webhook-disconnected',
            'shop-b', 'payos', 'disconnected', 'disconnected', ?, ?, 'verified-client-claim')
      `).run(now, now, now, now);
      database.prepare(`
        INSERT INTO payment_credentials (
          id, shop_id, integration_id, provider, status, version, key_version,
          client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
          api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
          credential_fingerprint, provider_ownership_fingerprint,
          created_by_user_id, created_at
        ) VALUES (
          'credential-unverified', 'shop-a', 'integration-unverified', 'payos',
          'error', 1, 'v1', 'x', 'x', 'x', 'x', 'x', 'x',
          'credential-fingerprint', 'provider-fingerprint', 'owner-a', ?
        )
      `).run(now);

      database.exec(readFileSync(
        join(process.cwd(), "migrations/0035_payment_provider_connections.sql"),
        "utf8",
      ));
      database.exec(readFileSync(
        join(process.cwd(), "migrations/0036_payos_identity_claim_hardening.sql"),
        "utf8",
      ));

      expect(database.prepare(`
        SELECT id, provider_identity_fingerprint AS fingerprint
        FROM payment_integrations ORDER BY id
      `).all()).toEqual([
        { fingerprint: "verified-client-claim", id: "integration-disconnected" },
        { fingerprint: null, id: "integration-unverified" },
      ]);
      expect(database.prepare(`
        SELECT id, provider_account_fingerprint AS fingerprint
        FROM payment_provider_connections ORDER BY id
      `).all()).toEqual([
        { fingerprint: null, id: "integration-disconnected" },
        { fingerprint: null, id: "integration-unverified" },
      ]);
      expect(database.prepare(`
        SELECT status, provider_ownership_fingerprint AS fingerprint
        FROM payment_credentials
        WHERE id = 'credential-unverified'
      `).get()).toEqual({ fingerprint: null, status: "error" });
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
