import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptPayOSCredentials } from "../../src/lib/payments/crypto";
import { createPayOSObjectSignature } from "../../src/lib/payments/payos";
import { decidePayment } from "../../src/lib/payments/decision";
import { normalizeReconciliation } from "../../src/lib/payments/store";
import type { AppBindings } from "../../src/lib/platform/bindings";

const mocked = vi.hoisted(() => ({ processPayOSWebhook: vi.fn() }));

vi.mock("../../src/lib/payments/webhooks", () => ({ processPayOSWebhook: mocked.processPayOSWebhook }));

import { parsePaymentExceptionEvidence, reconcilePendingPayments } from "../../src/lib/payments/reconciliation";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = new Date("2026-07-26T00:00:00.000Z");

async function reconciliationEnvironment(providerOrderCode: number) {
  const encrypted = await encryptPayOSCredentials({
    apiKey: "api-key-test",
    checksumKey: "checksum-key-test",
    clientId: "client-id-test",
  }, {
    credentialId: "credential-a",
    hmacSecret: "identifier-secret",
    integrationId: "integration-a",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
  });
  const sqlCalls: string[] = [];
  const attempt = {
    credentialId: "credential-a",
    id: "attempt-a",
    integrationId: "integration-a",
    providerOrderCode: 111,
    shopId: "shop-a",
    webhookPublicId: "webhook-a",
  };
  const database = {
    prepare(sql: string) {
      sqlCalls.push(sql);
      return {
        bind(...values: unknown[]) {
          void values;
          return {
            all: () => sql.includes("SELECT payment_attempts.id") ? { results: [attempt] } : { results: [] },
            first: () => {
              if (sql.includes("FROM payment_credentials")) return { ...encrypted, credentialId: "credential-a", integrationId: "integration-a", keyVersion: "v1", shopId: "shop-a", status: "active" };
              if (sql.includes("SELECT reconcile_attempts")) return { attempts: 0 };
              return null;
            },
            run: () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
  };
  const status = {
    amount: 100_000,
    amountPaid: 100_000,
    amountRemaining: 0,
    currency: "VND",
    description: "SELINOW000111",
    id: "link-a",
    orderCode: providerOrderCode,
    status: "PAID",
    transactions: [{ description: "SELINOW000111", reference: "reference-a", transactionDateTime: NOW.toISOString() }],
  };
  const signature = await createPayOSObjectSignature(status, "checksum-key-test");
  const fetcher = vi.fn(() => new Response(JSON.stringify({ code: "00", data: status, signature }), { headers: { "Content-Type": "application/json" }, status: 200 }));
  const env = { CREDENTIAL_KEK_V1: KEK, PLATFORM_DB: database } as unknown as AppBindings;
  return { env, fetcher, sqlCalls, status };
}

type QueryHook = (sql: string) => Promise<void> | void;

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: SQLInputValue[] = [],
    private readonly beforeQuery?: QueryHook,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }), this.beforeQuery);
  }

  async first<T>(): Promise<T | null> {
    await this.beforeQuery?.(this.sql);
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all(): Promise<{ results: unknown[] }> {
    await this.beforeQuery?.(this.sql);
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private batchTail = Promise.resolve();

  constructor(readonly database: DatabaseSync, private readonly beforeQuery?: QueryHook) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, [], this.beforeQuery);
  }

  batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const operation = this.batchTail.then(async () => {
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
    this.batchTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

async function seedReconciliationDatabase(database: DatabaseSync): Promise<void> {
  const now = NOW.toISOString();
  const expiresAt = new Date(NOW.getTime() + 30 * 60_000).toISOString();
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('reconcile-user-a', 'reconcile-a@example.test', 'Reconcile A', 'active', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-a', 'shop_reconcile_a', 'reconcile-a', 'Reconcile A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');
    INSERT INTO orders (id, public_id, shop_id, customer_id, order_number, source_channel, status, payment_status,
      fulfillment_status, subtotal_minor, discount_minor, total_minor, currency, locale, checkout_subject_hash,
      order_token_hash, expires_at, created_at, updated_at)
    VALUES ('order-reconcile-a', 'order_reconcile_a', 'shop-a', NULL, 'RECONCILE-1', 'web', 'pending_payment',
      'unpaid', 'reserved', 100000, 0, 100000, 'VND', 'vi', 'subject', 'token', '${expiresAt}', '${now}', '${now}');
    INSERT INTO payment_integrations (id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
      active_credential_id, connected_at, created_at, updated_at)
    VALUES ('integration-a', 'integration_reconcile_a', 'webhook_reconcile_a', 'shop-a', 'payos', 'active', 'verified', NULL, '${now}', '${now}', '${now}');
  `);
  const encrypted = await encryptPayOSCredentials({ apiKey: "api-key-test", checksumKey: "checksum-key-test", clientId: "client-id-test" }, {
    credentialId: "credential-a",
    hmacSecret: "identifier-secret",
    integrationId: "integration-a",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
  });
  database.prepare(`
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, provider_ownership_fingerprint, activated_at,
      created_by_user_id, created_at
    ) VALUES (?, 'shop-a', 'integration-a', 'payos', 'active', 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reconcile-user-a', ?)
  `).run(
    "credential-a",
    encrypted.clientIdCiphertextB64,
    encrypted.clientIdIvB64,
    encrypted.apiKeyCiphertextB64,
    encrypted.apiKeyIvB64,
    encrypted.checksumKeyCiphertextB64,
    encrypted.checksumKeyIvB64,
    encrypted.fingerprint,
    "provider-ownership-a",
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
    ) VALUES ('attempt-reconcile-a', 'payment_attempt_reconcile_a', 'shop-a', 'order-reconcile-a', 'integration-a',
      'credential-a', 'payos', 111, 'link-reconcile-a', 'PENDING', 'pending', 100000, 'VND', 'SELINOW000111',
      ?, ?, 0, ?, ?)
  `).run(expiresAt, new Date(NOW.getTime() - 60_000).toISOString(), now, now);
}

async function addTenantMismatchedCredential(database: DatabaseSync): Promise<void> {
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('reconcile-user-b', 'reconcile-b@example.test', 'Reconcile B', 'active', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-b', 'shop_reconcile_b', 'reconcile-b', 'Reconcile B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');
    INSERT INTO payment_integrations (id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
      active_credential_id, connected_at, created_at, updated_at)
    VALUES ('integration-b', 'integration_reconcile_b', 'webhook_reconcile_b', 'shop-b', 'payos', 'active', 'verified', NULL, '${now}', '${now}', '${now}');
  `);
  const encrypted = await encryptPayOSCredentials({ apiKey: "api-key-b", checksumKey: "checksum-key-b", clientId: "client-id-b" }, {
    credentialId: "credential-b",
    hmacSecret: "identifier-secret",
    integrationId: "integration-b",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-b",
  });
  database.prepare(`
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, provider_ownership_fingerprint, activated_at,
      created_by_user_id, created_at
    ) VALUES (?, 'shop-b', 'integration-b', 'payos', 'active', 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reconcile-user-b', ?)
  `).run(
    "credential-b",
    encrypted.clientIdCiphertextB64,
    encrypted.clientIdIvB64,
    encrypted.apiKeyCiphertextB64,
    encrypted.apiKeyIvB64,
    encrypted.checksumKeyCiphertextB64,
    encrypted.checksumKeyIvB64,
    encrypted.fingerprint,
    "provider-ownership-b",
    now,
    now,
  );
}

describe("payment reconciliation identity", () => {
  beforeEach(() => {
    mocked.processPayOSWebhook.mockReset();
    vi.restoreAllMocks();
  });

  it("preserves the order code from the provider-signed status", () => {
    const normalized = normalizeReconciliation({
      amount: 100_000,
      amountPaid: 100_000,
      amountRemaining: 0,
      currency: "VND",
      description: "SELINOW000222",
      id: "link-a",
      orderCode: 222,
      status: "PAID",
      transactions: [],
    });

    expect(normalized.orderCode).toBe(222);
    expect(normalized.currency).toBe("VND");
  });

  it("uses the latest transaction evidence for a cumulative payment", () => {
    const early = NOW.toISOString();
    const late = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const normalized = normalizeReconciliation({
      amount: 100_000,
      amountPaid: 100_000,
      amountRemaining: 0,
      currency: "VND",
      description: "SELINOW000111",
      id: "link-a",
      orderCode: 111,
      status: "PAID",
      transactions: [
        { description: "SELINOW000111", reference: "reference-early", transactionDateTime: early },
        { description: "SELINOW000111", reference: "reference-late", transactionDateTime: late },
      ],
    });

    expect(normalized.occurredAt).toBe(late);
    expect(normalized.reference).toBe("reference-late");
    expect(decidePayment({
      ...normalized,
      expectedAmount: 100_000,
      expectedCurrency: "VND",
      expectedDescription: "SELINOW000111",
      expectedPaymentLinkId: "link-a",
      providerOrderCode: 111,
      reservationExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      paymentLinkId: normalized.paymentLinkId,
    })).toBe("late");
  });

  it("does not treat an incomplete PAID transaction list as actionable", () => {
    const normalized = normalizeReconciliation({
      amount: 100_000,
      amountPaid: 100_000,
      amountRemaining: 0,
      currency: "VND",
      description: "SELINOW000111",
      id: "link-a",
      orderCode: 111,
      status: "PAID",
      transactions: [{ description: "SELINOW000111", reference: "reference-a" }],
    });

    expect(normalized.success).toBe(false);
  });

  it("rejects a signed status for a different order before webhook processing", async () => {
    const runtime = await reconciliationEnvironment(222);
    vi.stubGlobal("fetch", runtime.fetcher);

    await expect(reconcilePendingPayments(runtime.env, NOW)).resolves.toEqual({ failed: 1, processed: 0 });
    expect(runtime.fetcher).toHaveBeenCalledTimes(1);
    expect(mocked.processPayOSWebhook).not.toHaveBeenCalled();
    expect(runtime.sqlCalls.some((sql) => sql.includes("INSERT INTO payment_events"))).toBe(false);
  });

  it("forwards the provider order code when the status identity matches", async () => {
    const runtime = await reconciliationEnvironment(111);
    mocked.processPayOSWebhook.mockResolvedValue({ duplicate: false, processed: true, state: "paid_exact" });
    vi.stubGlobal("fetch", runtime.fetcher);

    await expect(reconcilePendingPayments(runtime.env, NOW)).resolves.toEqual({ failed: 0, processed: 1 });
    expect(mocked.processPayOSWebhook).toHaveBeenCalledTimes(1);
    const call = mocked.processPayOSWebhook.mock.calls[0]?.[0] as { body: { data: { currency: string; orderCode: number } } };
    expect(call.body.data.orderCode).toBe(111);
    expect(call.body.data.currency).toBe("VND");
  });
});

describe("payment exception evidence projection", () => {
  it("keeps only allowlisted, render-safe fields", () => {
    expect(parsePaymentExceptionEvidence(JSON.stringify({
      amount: 97_000,
      expectedAmount: 100_000,
      occurredAt: "2026-07-29T01:02:03.000Z",
      expectedKeys: 2,
      reservedKeys: 1,
      reference: "provider-reference-must-not-escape",
      providerPayload: { checksumKey: "secret" },
    }))).toEqual({
      expectedAmount: 100_000,
      expectedKeys: 2,
      occurredAt: "2026-07-29T01:02:03.000Z",
      receivedAmount: 97_000,
      reservedKeys: 1,
    });
  });

  it("drops malformed values and invalid JSON without throwing", () => {
    expect(parsePaymentExceptionEvidence(JSON.stringify({
      amount: -1,
      expectedAmount: 1.5,
      occurredAt: "1",
      expectedKeys: "2",
      reservedKeys: Number.MAX_SAFE_INTEGER + 1,
    }))).toEqual({ expectedAmount: null, expectedKeys: null, occurredAt: null, receivedAmount: null, reservedKeys: null });
    expect(parsePaymentExceptionEvidence("not-json")).toEqual({ expectedAmount: null, expectedKeys: null, occurredAt: null, receivedAmount: null, reservedKeys: null });
  });
});

describe("payment reconciliation leases and tenant binding", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    await seedReconciliationDatabase(database);
    env = {
      APP_ENV: "local",
      CREDENTIAL_KEK_V1: KEK,
      IDENTIFIER_HMAC_SECRET: "identifier-secret",
      PLATFORM_DB: new SqliteD1(database),
    } as unknown as AppBindings;
    mocked.processPayOSWebhook.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
  });

  function providerStatus(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      amount: 100_000,
      amountPaid: 100_000,
      amountRemaining: 0,
      currency: "VND",
      description: "SELINOW000111",
      id: "link-reconcile-a",
      orderCode: 111,
      status: "PAID",
      transactions: [{ description: "SELINOW000111", reference: "reconcile-reference", transactionDateTime: NOW.toISOString() }],
      ...overrides,
    };
  }

  function providerFetcher(status: Record<string, unknown>): ReturnType<typeof vi.fn> {
    return vi.fn(async () => {
      const signature = await createPayOSObjectSignature(status, "checksum-key-test");
      return new Response(JSON.stringify({ code: "00", data: status, signature }), { status: 200 });
    });
  }

  it("lets two schedulers contend on one real SQLite lease and processes only the winner", async () => {
    let reads = 0;
    let release!: () => void;
    const bothReadDue = new Promise<void>((resolve) => { release = resolve; });
    const barrier: QueryHook = async (sql) => {
      if (!sql.includes("SELECT payment_attempts.id")) return;
      reads += 1;
      if (reads === 2) release();
      await bothReadDue;
    };
    const d1 = new SqliteD1(database, barrier);
    env = { ...env, PLATFORM_DB: d1 } as unknown as AppBindings;
    const fetcher = providerFetcher(providerStatus());
    vi.stubGlobal("fetch", fetcher);
    mocked.processPayOSWebhook.mockResolvedValue({ duplicate: false, processed: true, state: "paid_exact" });

    const outcomes = await Promise.all([
      reconcilePendingPayments(env, NOW),
      reconcilePendingPayments(env, NOW),
    ]);

    expect(reads).toBe(2);
    expect(outcomes).toEqual(expect.arrayContaining([
      { failed: 0, processed: 1 },
      { failed: 0, processed: 0 },
    ]));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocked.processPayOSWebhook).toHaveBeenCalledTimes(1);
    expect(database.prepare(`
      SELECT reconcile_attempts AS reconcileAttempts, lease_token AS leaseToken,
        lease_expires_at AS leaseExpiresAt, next_reconcile_at AS nextReconcileAt
      FROM payment_attempts WHERE id = 'attempt-reconcile-a'
    `).get()).toEqual({
      leaseExpiresAt: null,
      leaseToken: null,
      nextReconcileAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      reconcileAttempts: 1,
    });
  });

  it("does not clear a successor lease when the original scheduler loses ownership", async () => {
    const fetcher = providerFetcher(providerStatus());
    vi.stubGlobal("fetch", fetcher);
    mocked.processPayOSWebhook.mockImplementation(() => {
      database.prepare("UPDATE payment_attempts SET lease_token = 'successor', lease_expires_at = ? WHERE id = 'attempt-reconcile-a'")
        .run(new Date(NOW.getTime() + 120_000).toISOString());
      return { duplicate: false, processed: true, state: "paid_exact" };
    });

    await expect(reconcilePendingPayments(env, NOW)).resolves.toEqual({ failed: 0, processed: 1 });
    expect(database.prepare(`
      SELECT lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
        last_reconciled_at AS lastReconciledAt
      FROM payment_attempts WHERE id = 'attempt-reconcile-a'
    `).get()).toEqual({
      lastReconciledAt: null,
      leaseExpiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
      leaseToken: "successor",
    });
  });

  it("records retry backoff and transitions a creating attempt to error after provider failure", async () => {
    database.prepare("UPDATE payment_attempts SET state = 'creating' WHERE id = 'attempt-reconcile-a'").run();
    const fetcher = vi.fn(() => new Response(JSON.stringify({ code: "01", desc: "provider unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(reconcilePendingPayments(env, NOW)).resolves.toEqual({ failed: 1, processed: 0 });
    const row = database.prepare(`
      SELECT state, reconcile_attempts AS reconcileAttempts,
        next_reconcile_at AS nextReconcileAt, lease_token AS leaseToken,
        lease_expires_at AS leaseExpiresAt, last_safe_error_code AS lastSafeErrorCode
      FROM payment_attempts WHERE id = 'attempt-reconcile-a'
    `).get() as {
      lastSafeErrorCode: string | null;
      leaseExpiresAt: string | null;
      leaseToken: string | null;
      nextReconcileAt: string;
      reconcileAttempts: number;
      state: string;
    };
    expect(row.state).toBe("error");
    expect(row.reconcileAttempts).toBe(1);
    expect(row.lastSafeErrorCode).toBe("provider_reconcile_failed");
    expect(row.leaseToken).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    const delay = Date.parse(row.nextReconcileAt) - NOW.getTime();
    expect(delay).toBeGreaterThanOrEqual(60_000);
    expect(delay).toBeLessThan(90_000);
    expect(mocked.processPayOSWebhook).not.toHaveBeenCalled();
  });

  it("binds reconciliation credentials to the attempt tenant", async () => {
    await addTenantMismatchedCredential(database);
    expect(() => database.prepare("UPDATE payment_attempts SET credential_id = 'credential-b' WHERE id = 'attempt-reconcile-a'").run())
      .toThrow("payment_attempt_credential_scope_mismatch");
    // Simulate a legacy/corrupt row after proving the current migration guard;
    // reconciliation must still fail closed on its credential+shop lookup.
    database.exec("DROP TRIGGER payment_attempts_credential_update_guard");
    database.prepare("UPDATE payment_attempts SET credential_id = 'credential-b' WHERE id = 'attempt-reconcile-a'").run();
    const fetcher = providerFetcher(providerStatus());
    vi.stubGlobal("fetch", fetcher);

    await expect(reconcilePendingPayments(env, NOW)).resolves.toEqual({ failed: 1, processed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocked.processPayOSWebhook).not.toHaveBeenCalled();
    expect(database.prepare(`
      SELECT state, reconcile_attempts AS reconcileAttempts,
        last_safe_error_code AS lastSafeErrorCode, lease_token AS leaseToken
      FROM payment_attempts WHERE id = 'attempt-reconcile-a'
    `).get()).toEqual({
      lastSafeErrorCode: "provider_reconcile_failed",
      leaseToken: null,
      reconcileAttempts: 1,
      state: "pending",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_attempts WHERE shop_id = 'shop-b'").get()).toEqual({ count: 0 });
  });
});
