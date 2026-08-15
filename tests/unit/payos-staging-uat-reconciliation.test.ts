import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptPayOSCredentials } from "../../src/lib/payments/crypto";
import { payOSProviderIdentityFingerprint } from "../../src/lib/payments/payos-admission";
import type { AppBindings } from "../../src/lib/platform/bindings";

const dependencies = vi.hoisted(() => ({
  getShopForMember: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("../../src/lib/tenants/store", () => ({ getShopForMember: dependencies.getShopForMember }));
vi.mock("../../src/lib/payments/reconciliation", () => ({ reconcilePayOSAttemptWithProvider: dependencies.reconcile }));

import { reconcilePayOSStagingUatAttempt } from "../../src/lib/payments/staging-uat-reconciliation";

const ATTEMPT_A = "pay_00000000-0000-4000-8000-000000000001";
const ATTEMPT_B = "pay_00000000-0000-4000-8000-000000000002";
const EVENT_ID = "pev_00000000-0000-4000-8000-000000000001";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = new Date("2026-08-11T05:00:00.000Z");
const PAYLOAD_HASH = "a".repeat(64);
const SHOP_PUBLIC_A = "shop_00000000-0000-4000-8000-000000000001";

class Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.database, this.sql, values.map((value): SQLInputValue => {
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

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.database, sql);
  }

  async batch(statements: Statement[]): Promise<Array<{ meta: { changes: number } }>> {
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

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

async function createFixture(): Promise<{ database: DatabaseSync; env: AppBindings }> {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const now = NOW.toISOString();
  const expiresAt = new Date(NOW.getTime() + 30 * 60_000).toISOString();
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('owner-a', 'owner-a@example.test', 'Owner A', 'active', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-a', '${SHOP_PUBLIC_A}', 'shop-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');
    INSERT INTO orders (id, public_id, shop_id, customer_id, order_number, source_channel, status, payment_status,
      fulfillment_status, subtotal_minor, discount_minor, total_minor, currency, locale, checkout_subject_hash,
      order_token_hash, expires_at, created_at, updated_at)
    VALUES
      ('order-a', 'order_00000000-0000-4000-8000-000000000001', 'shop-a', NULL, 'UAT-1', 'web', 'pending_payment',
        'unpaid', 'reserved', 10000, 0, 10000, 'VND', 'vi', 'subject-a', 'token-a', '${expiresAt}', '${now}', '${now}'),
      ('order-b', 'order_00000000-0000-4000-8000-000000000002', 'shop-a', NULL, 'UAT-2', 'web', 'pending_payment',
        'unpaid', 'reserved', 10000, 0, 10000, 'VND', 'vi', 'subject-b', 'token-b', '${expiresAt}', '${now}', '${now}');
  `);
  const baseEnv = {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    APP_ENV: "staging",
    CREDENTIAL_KEK_V1: KEK,
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
    PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
    SESSION_SECRET: "session-secret",
  } as unknown as AppBindings;
  const credentials = { apiKey: "api-key-test", checksumKey: "checksum-key-test", clientId: "client-id-test" };
  const providerIdentityFingerprint = await payOSProviderIdentityFingerprint(baseEnv, credentials);
  const encrypted = await encryptPayOSCredentials(credentials, {
    credentialId: "credential-a",
    hmacSecret: baseEnv.IDENTIFIER_HMAC_SECRET,
    integrationId: "integration-a",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
  });
  database.prepare(`
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
      active_credential_id, connected_at, created_at, updated_at, provider_identity_fingerprint
    ) VALUES ('integration-a', 'payint_00000000-0000-4000-8000-000000000001',
      'paywh_00000000-0000-4000-8000-000000000001', 'shop-a', 'payos', 'active', 'verified',
      NULL, ?, ?, ?, ?)
  `).run(now, now, now, providerIdentityFingerprint);
  database.prepare(`
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, provider_ownership_fingerprint, activated_at,
      created_by_user_id, created_at
    ) VALUES ('credential-a', 'shop-a', 'integration-a', 'payos', 'active', 1, 'v1',
      ?, ?, ?, ?, ?, ?, ?, 'provider-ownership-a', ?, 'owner-a', ?)
  `).run(
    encrypted.clientIdCiphertextB64,
    encrypted.clientIdIvB64,
    encrypted.apiKeyCiphertextB64,
    encrypted.apiKeyIvB64,
    encrypted.checksumKeyCiphertextB64,
    encrypted.checksumKeyIvB64,
    encrypted.fingerprint,
    now,
    now,
  );
  database.prepare("UPDATE payment_integrations SET active_credential_id = 'credential-a' WHERE id = 'integration-a'").run();
  database.prepare(`
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, provider_payment_link_id, provider_status, state,
      expected_amount_minor, currency, expected_description, expires_at,
      next_reconcile_at, reconcile_attempts, created_at, updated_at
    ) VALUES
      ('attempt-a', ?, 'shop-a', 'order-a', 'integration-a', 'credential-a', 'payos',
        101, 'link-a', 'PENDING', 'pending', 10000, 'VND', 'SELINOW000101', ?, ?, 0, ?, ?),
      ('attempt-b', ?, 'shop-a', 'order-b', 'integration-a', 'credential-a', 'payos',
        102, 'link-b', 'PENDING', 'pending', 10000, 'VND', 'SELINOW000102', ?, ?, 0, ?, ?)
  `).run(ATTEMPT_A, expiresAt, now, now, now, ATTEMPT_B, expiresAt, now, now, now);
  return {
    database,
    env: {
      ...baseEnv,
      PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT: providerIdentityFingerprint,
    },
  };
}

function serviceInput(env: AppBindings, overrides: Partial<Parameters<typeof reconcilePayOSStagingUatAttempt>[0]> = {}) {
  return {
    attemptPublicId: ATTEMPT_A,
    env,
    idempotencyKey: "payos-uat-reconcile-0001",
    now: NOW,
    requestId: "request-payos-uat-0001",
    shopPublicId: SHOP_PUBLIC_A,
    userId: "owner-a",
    ...overrides,
  };
}

describe("PayOS staging UAT direct reconciliation", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(async () => {
    ({ database, env } = await createFixture());
    dependencies.getShopForMember.mockReset();
    dependencies.getShopForMember.mockResolvedValue({ row: { role: "owner", shop_id: "shop-a" }, shop: {} });
    dependencies.reconcile.mockReset();
    dependencies.reconcile.mockImplementation(async (input: { attempt: { id: string; integrationId: string; shopId: string }; env: AppBindings }) => {
      await input.env.PLATFORM_DB.prepare(`
        INSERT INTO payment_events (
          id, shop_id, payment_attempt_id, integration_id, provider,
          provider_event_reference, payload_hash, signature_verified,
          normalized_state, process_result, received_at, processed_at
        ) VALUES (?, ?, ?, ?, 'payos', 'uat-safe-reference', ?, 1,
          'paid_exact', 'processed', ?, ?)
      `).bind(EVENT_ID, input.attempt.shopId, input.attempt.id, input.attempt.integrationId, PAYLOAD_HASH, NOW.toISOString(), NOW.toISOString()).run();
      return { payloadHash: PAYLOAD_HASH, result: { duplicate: false, processed: true, state: "paid_exact" } };
    });
  });

  afterEach(() => {
    database.close();
  });

  it("persists only safe authority evidence and replays without another provider reconciliation", async () => {
    const first = await reconcilePayOSStagingUatAttempt(serviceInput(env));
    const replay = await reconcilePayOSStagingUatAttempt(serviceInput(env, { requestId: "request-payos-uat-replay" }));

    expect(first).toEqual({
      attemptPublicId: ATTEMPT_A,
      duplicate: false,
      eventReference: `event:${EVENT_ID}`,
      processed: true,
      provider: "payos",
      providerEnvironment: "production_controlled",
      replayed: false,
      requestReference: "request:request-payos-uat-0001",
      state: "paid_exact",
      verificationMethod: "verified_provider_response",
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(dependencies.reconcile).toHaveBeenCalledTimes(1);

    const audit = database.prepare(`
      SELECT action, safe_metadata_json AS metadata, request_id AS requestId
      FROM audit_logs WHERE action = 'payos.staging_uat_reconciled'
    `).get() as { action: string; metadata: string; requestId: string };
    expect(audit.action).toBe("payos.staging_uat_reconciled");
    expect(JSON.parse(audit.metadata)).toEqual({
      attemptPublicId: ATTEMPT_A,
      duplicate: false,
      eventReference: `event:${EVENT_ID}`,
      processed: true,
      providerEnvironment: "production_controlled",
      state: "paid_exact",
      verificationMethod: "verified_provider_response",
    });
    expect(audit.metadata).not.toContain("api-key-test");
    expect(audit.metadata).not.toContain("checksum-key-test");
    expect(audit.metadata).not.toContain("uat-safe-reference");
  });

  it("rejects an idempotency key reused for a different exact attempt", async () => {
    await reconcilePayOSStagingUatAttempt(serviceInput(env));
    await expect(reconcilePayOSStagingUatAttempt(serviceInput(env, { attemptPublicId: ATTEMPT_B })))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(dependencies.reconcile).toHaveBeenCalledTimes(1);
  });

  it("fails production closed before lease, audit, idempotency or provider execution", async () => {
    const production = { ...env, APP_ENV: "production" as const };
    await expect(reconcilePayOSStagingUatAttempt(serviceInput(production)))
      .rejects.toMatchObject({ code: "payment_provider_environment_not_admitted", status: 409 });
    expect(dependencies.reconcile).not.toHaveBeenCalled();
    expect(database.prepare("SELECT lease_token AS leaseToken FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ leaseToken: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'payos.staging_uat_reconciled'").get()).toEqual({ count: 0 });
  });

  it("fails closed when the controlled fingerprint does not match the tenant integration", async () => {
    const mismatched = { ...env, PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT: "B".repeat(43) };
    await expect(reconcilePayOSStagingUatAttempt(serviceInput(mismatched)))
      .rejects.toMatchObject({ code: "payment_provider_environment_not_admitted", status: 409 });
    expect(dependencies.reconcile).not.toHaveBeenCalled();
  });

  it("does not resolve an attempt outside the authorized tenant", async () => {
    dependencies.getShopForMember.mockResolvedValueOnce({ row: { role: "owner", shop_id: "shop-other" }, shop: {} });
    await expect(reconcilePayOSStagingUatAttempt(serviceInput(env)))
      .rejects.toMatchObject({ code: "payment_attempt_not_found", status: 404 });
    expect(dependencies.reconcile).not.toHaveBeenCalled();
  });
});
