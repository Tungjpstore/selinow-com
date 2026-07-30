import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Json } from "../../src/lib/core/crypto";
import { encryptPayOSCredentials } from "../../src/lib/payments/crypto";
import { createPayOSObjectSignature } from "../../src/lib/payments/payos";
import { processPayOSWebhook } from "../../src/lib/payments/webhooks";
import type { AppBindings } from "../../src/lib/platform/bindings";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = new Date("2026-07-26T04:00:00.000Z");
const SHOP_ID = "shop-a";
const INTEGRATION_ID = "payment-integration-a";
const ACTIVE_CREDENTIAL_ID = "payment-credential-active";
const GRACE_CREDENTIAL_ID = "payment-credential-grace";
const SHARED_GRACE_CREDENTIAL_ID = "payment-credential-shared-grace";
const MISMATCH_GRACE_CREDENTIAL_ID = "payment-credential-mismatch-grace";
const PENDING_CREDENTIAL_ID = "payment-credential-pending";
const ACTIVE_CHECKSUM_KEY = "active-checksum-key";
const GRACE_CHECKSUM_KEY = "grace-checksum-key";
const MISMATCH_GRACE_CHECKSUM_KEY = "mismatch-grace-checksum-key";
const PENDING_CHECKSUM_KEY = "pending-checksum-key";
const ORDER_CODE = 123_456;
const SECOND_SHOP_ID = "shop-b";
const SECOND_INTEGRATION_ID = "payment-integration-b";
const SECOND_CREDENTIAL_ID = "payment-credential-b";
const SECOND_CHECKSUM_KEY = "shop-b-checksum-key";
const SECOND_ORDER_CODE = 654_321;

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
    private readonly beforeAll?: (sql: string) => Promise<void> | void,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }), this.beforeAll);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  async all(): Promise<{ results: unknown[] }> {
    await this.beforeAll?.(this.sql);
    return { results: this.database.prepare(this.sql).all(...this.values) };
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

function bindings(
  database: DatabaseSync,
  beforeBatch?: () => void,
  beforeAll?: (sql: string) => Promise<void> | void,
): AppBindings {
  let batchTail = Promise.resolve();
  const platformDb = {
    batch(statements: D1PreparedStatement[]) {
      const execute = async () => {
        beforeBatch?.();
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
      };
      const result = batchTail.then(execute, execute);
      batchTail = result.then(() => undefined, () => undefined);
      return result;
    },
    prepare(sql: string) {
      return new SqliteStatement(database, sql, [], beforeAll) as unknown as D1PreparedStatement;
    },
  };
  return {
    APP_ENV: "local",
    CREDENTIAL_KEK_V1: KEK,
    IDENTIFIER_HMAC_SECRET: "payment-webhook-identifier-secret",
    PLATFORM_DB: platformDb,
  } as unknown as AppBindings;
}

async function insertCredential(input: {
  checksumKey: string;
  credentialId: string;
  database: DatabaseSync;
  status: "active" | "grace" | "pending";
  version: number;
  integrationId?: string;
  shopId?: string;
  createdByUserId?: string;
}): Promise<void> {
  const integrationId = input.integrationId ?? INTEGRATION_ID;
  const shopId = input.shopId ?? SHOP_ID;
  const createdByUserId = input.createdByUserId ?? "seller-a";
  const encrypted = await encryptPayOSCredentials({
    apiKey: `api-${input.credentialId}`,
    checksumKey: input.checksumKey,
    clientId: `client-${input.credentialId}`,
  }, {
    credentialId: input.credentialId,
    hmacSecret: "payment-webhook-test-hmac",
    integrationId,
    kek: KEK,
    keyVersion: "v1",
    shopId,
  });
  const now = NOW.toISOString();
  input.database.prepare(`
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, provider_ownership_fingerprint, activated_at,
      grace_ends_at, created_by_user_id, created_at
    ) VALUES (?, ?, ?, 'payos', ?, ?, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.credentialId,
    shopId,
    integrationId,
    input.status,
    input.version,
    encrypted.clientIdCiphertextB64,
    encrypted.clientIdIvB64,
    encrypted.apiKeyCiphertextB64,
    encrypted.apiKeyIvB64,
    encrypted.checksumKeyCiphertextB64,
    encrypted.checksumKeyIvB64,
    encrypted.fingerprint,
    `provider-ownership-${input.credentialId}`,
    input.status === "pending" ? null : now,
    input.status === "grace" ? "2099-01-01T00:00:00.000Z" : null,
    createdByUserId,
    now,
  );
}

async function seed(database: DatabaseSync): Promise<void> {
  const now = NOW.toISOString();
  const expiresAt = new Date(NOW.getTime() + 30 * 60_000).toISOString();
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('seller-a', 'seller-a@example.test', 'Seller A', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, 'shop_00000000-0000-4000-8000-000000000001', 'shop-a',
      'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(SHOP_ID, now, now);
  database.prepare(`
    INSERT INTO products (
      id, shop_id, category_id, slug, title, description, status,
      fulfillment_type, version, created_at, updated_at
    ) VALUES ('product-a', ?, NULL, 'product-a', 'Product A', '', 'active',
      'license_key', 1, ?, ?)
  `).run(SHOP_ID, now, now);
  database.prepare(`
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      compare_at_minor, currency, min_per_order, max_per_order, status,
      version, created_at, updated_at
    ) VALUES ('variant-a', ?, 'product-a', 'SKU-A', 'Default', '{}', 100000,
      NULL, 'VND', 1, 10, 'active', 1, ?, ?)
  `).run(SHOP_ID, now, now);
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, created_at, updated_at
    ) VALUES ('order-a', 'order_00000000-0000-4000-8000-000000000001', ?, NULL,
      'SELINOW-0001', 'web', 'pending_payment', 'unpaid', 'reserved', 100000, 0,
      100000, 'VND', 'vi', 'subject-hash', 'order-token-hash', ?, ?, ?)
  `).run(SHOP_ID, expiresAt, now, now);
  database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES ('order-item-a', ?, 'order-a', 'product-a', 'variant-a', 'Product A',
      'Default', 'SKU-A', 100000, 1, 100000, 'license_key', ?)
  `).run(SHOP_ID, now);
  database.prepare(`
    INSERT INTO inventory_batches (
      id, shop_id, variant_id, source, filename_sanitized, total_count,
      accepted_count, rejected_count, created_by_user_id, created_at
    ) VALUES ('batch-a', ?, 'variant-a', 'paste', NULL, 1, 1, 0, 'seller-a', ?)
  `).run(SHOP_ID, now);
  database.prepare(`
    INSERT INTO inventory_keys (
      id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
      key_version, key_fingerprint, reservation_token, reserved_order_item_id,
      reserved_until, created_at
    ) VALUES ('inventory-key-a', ?, 'variant-a', 'batch-a', 'reserved', 'ciphertext',
      'iv', 'v1', 'fingerprint-a', 'reservation-a', 'order-item-a', ?, ?)
  `).run(SHOP_ID, expiresAt, now);
  database.prepare(`
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status,
      webhook_status, active_credential_id, connected_at, created_at, updated_at
    ) VALUES (?, 'payint-a', 'paywh-a', ?, 'payos', 'active', 'verified', NULL, ?, ?, ?)
  `).run(INTEGRATION_ID, SHOP_ID, now, now, now);
  await insertCredential({ checksumKey: GRACE_CHECKSUM_KEY, credentialId: GRACE_CREDENTIAL_ID, database, status: "grace", version: 1 });
  await insertCredential({ checksumKey: ACTIVE_CHECKSUM_KEY, credentialId: SHARED_GRACE_CREDENTIAL_ID, database, status: "grace", version: 2 });
  await insertCredential({ checksumKey: MISMATCH_GRACE_CHECKSUM_KEY, credentialId: MISMATCH_GRACE_CREDENTIAL_ID, database, status: "grace", version: 3 });
  await insertCredential({ checksumKey: ACTIVE_CHECKSUM_KEY, credentialId: ACTIVE_CREDENTIAL_ID, database, status: "active", version: 4 });
  await insertCredential({ checksumKey: PENDING_CHECKSUM_KEY, credentialId: PENDING_CREDENTIAL_ID, database, status: "pending", version: 5 });
  database.prepare("UPDATE payment_integrations SET active_credential_id = ? WHERE id = ? AND shop_id = ?")
    .run(ACTIVE_CREDENTIAL_ID, INTEGRATION_ID, SHOP_ID);
  database.prepare(`
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, provider_payment_link_id, provider_status, state,
      expected_amount_minor, currency, expected_description, expires_at,
      created_at, updated_at
    ) VALUES ('attempt-a', 'pattempt-a', ?, 'order-a', ?, ?, 'payos', ?, 'link-a',
      'PENDING', 'pending', 100000, 'VND', 'SELINOW123456', ?, ?, ?)
  `).run(SHOP_ID, INTEGRATION_ID, ACTIVE_CREDENTIAL_ID, ORDER_CODE, expiresAt, now, now);
}

async function seedSecondTenantAttempt(database: DatabaseSync): Promise<void> {
  const now = NOW.toISOString();
  const expiresAt = new Date(NOW.getTime() + 30 * 60_000).toISOString();
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, 'shop_00000000-0000-4000-8000-000000000002', 'shop-b',
      'Shop B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(SECOND_SHOP_ID, now, now);
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, created_at, updated_at
    ) VALUES ('order-b', 'order_00000000-0000-4000-8000-000000000002', ?, NULL,
      'SELINOW-0002', 'web', 'pending_payment', 'unpaid', 'reserved', 100000, 0,
      100000, 'VND', 'vi', 'subject-hash-b', 'order-token-hash-b', ?, ?, ?)
  `).run(SECOND_SHOP_ID, expiresAt, now, now);
  database.prepare(`
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status,
      webhook_status, active_credential_id, connected_at, created_at, updated_at
    ) VALUES (?, 'payint-b', 'paywh-b', ?, 'payos', 'active', 'verified', NULL, ?, ?, ?)
  `).run(SECOND_INTEGRATION_ID, SECOND_SHOP_ID, now, now, now);
  await insertCredential({
    checksumKey: SECOND_CHECKSUM_KEY,
    credentialId: SECOND_CREDENTIAL_ID,
    database,
    integrationId: SECOND_INTEGRATION_ID,
    shopId: SECOND_SHOP_ID,
    status: "active",
    version: 1,
  });
  database.prepare("UPDATE payment_integrations SET active_credential_id = ? WHERE id = ? AND shop_id = ?")
    .run(SECOND_CREDENTIAL_ID, SECOND_INTEGRATION_ID, SECOND_SHOP_ID);
  database.prepare(`
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, provider_payment_link_id, provider_status, state,
      expected_amount_minor, currency, expected_description, expires_at,
      created_at, updated_at
    ) VALUES ('attempt-b', 'pattempt-b', ?, 'order-b', ?, ?, 'payos', ?, 'link-b',
      'PENDING', 'pending', 100000, 'VND', 'SELINOW654321', ?, ?, ?)
  `).run(
    SECOND_SHOP_ID,
    SECOND_INTEGRATION_ID,
    SECOND_CREDENTIAL_ID,
    SECOND_ORDER_CODE,
    expiresAt,
    now,
    now,
  );
}

function bodyData(reference: string, orderCode = ORDER_CODE, amount = 100_000): Record<string, unknown> {
  return {
    amount,
    code: "00",
    currency: "VND",
    desc: "Thành công",
    description: "SELINOW123456",
    orderCode,
    paymentLinkId: "link-a",
    reference,
    transactionDateTime: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
  };
}

async function webhookBody(reference: string, checksumKey: string, orderCode = ORDER_CODE, amount = 100_000): Promise<Record<string, unknown>> {
  const data = bodyData(reference, orderCode, amount);
  return {
    code: "00",
    data,
    signature: await createPayOSObjectSignature(data, checksumKey),
    success: true,
  };
}

async function reversalWebhookBody(
  reference: string,
  checksumKey: string,
  reversalKind: string = "refund",
  amount = 100_000,
): Promise<Record<string, unknown>> {
  const data = { ...bodyData(reference, ORDER_CODE, amount), reversalKind };
  return {
    code: "00",
    data,
    signature: await createPayOSObjectSignature(data, checksumKey),
    success: true,
  };
}

describe("PayOS webhook credential ownership", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    await seed(database);
    env = bindings(database);
  });

  afterEach(() => {
    database.close();
  });

  it("keeps a same-tenant provider order code on the normal payment path", async () => {
    await expect(processPayOSWebhook({
      body: await webhookBody("same-tenant-order-code", ACTIVE_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toEqual({ duplicate: false, processed: true, state: "paid_exact" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get())
      .toEqual({ state: "paid_exact" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "paid" });
  });

  it("does not reveal whether an unmapped provider order code belongs to another tenant", async () => {
    await seedSecondTenantAttempt(database);
    const crossTenant = await processPayOSWebhook({
      body: await webhookBody("cross-tenant-order-code", ACTIVE_CHECKSUM_KEY, SECOND_ORDER_CODE),
      env,
      webhookPublicId: "paywh-a",
    });
    const absent = await processPayOSWebhook({
      body: await webhookBody("absent-order-code", ACTIVE_CHECKSUM_KEY, SECOND_ORDER_CODE + 1),
      env,
      webhookPublicId: "paywh-a",
    });

    expect(crossTenant).toEqual({ duplicate: false, processed: false, state: "validation_probe" });
    expect(absent).toEqual(crossTenant);
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-b'").get())
      .toEqual({ state: "pending" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-b'").get())
      .toEqual({ paymentStatus: "unpaid" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_events WHERE shop_id = ?").get(SECOND_SHOP_ID))
      .toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM payment_events
      WHERE shop_id = ? AND integration_id = ? AND payment_attempt_id IS NULL
    `).get(SHOP_ID, INTEGRATION_ID)).toEqual({ count: 2 });
  });

  it("rejects a grace credential for an active-credential attempt without poisoning the valid retry", async () => {
    const reference = "credential-mismatch-then-valid";
    await expect(processPayOSWebhook({
      body: await webhookBody(reference, MISMATCH_GRACE_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).rejects.toMatchObject({ code: "webhook_identity_mismatch", status: 400 });

    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "pending" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "unpaid" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get())
      .toEqual({ status: "reserved" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
    const mismatchEvent = database.prepare(`
      SELECT payment_attempt_id AS paymentAttemptId, provider_event_reference AS reference
      FROM payment_events
    `).get() as { paymentAttemptId: string | null; reference: string };
    expect(mismatchEvent.paymentAttemptId).toBeNull();
    expect(mismatchEvent.reference).toMatch(/^identity:/u);

    await expect(processPayOSWebhook({
      body: await webhookBody(reference, ACTIVE_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toMatchObject({ duplicate: false, processed: true, state: "paid_exact" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "paid_exact" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "paid" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get())
      .toEqual({ status: "sold" });
  });

  it("allows an unexpired grace credential to process only its own attempt", async () => {
    database.prepare("UPDATE payment_attempts SET credential_id = ? WHERE id = 'attempt-a'")
      .run(GRACE_CREDENTIAL_ID);
    await expect(processPayOSWebhook({
      body: await webhookBody("grace-owned-attempt", GRACE_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toMatchObject({ duplicate: false, processed: true, state: "paid_exact" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "paid_exact" });
  });

  it("emits exactly one order.paid event for exact fulfillment and no second event on duplicate delivery", async () => {
    const reference = "exact-paid-event-idempotency";
    const body = await webhookBody(reference, ACTIVE_CHECKSUM_KEY);

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }))
      .resolves.toEqual({ duplicate: false, processed: true, state: "paid_exact" });
    const paidEvents = database.prepare(`
      SELECT event_type AS eventType, aggregate_type AS aggregateType,
        aggregate_id AS aggregateId, idempotency_key_hash AS idempotencyHash,
        source_connection_id AS sourceConnectionId, status
      FROM domain_events
      WHERE shop_id = ? AND event_type = 'order.paid'
    `).all(SHOP_ID) as Array<Record<string, unknown>>;
    expect(paidEvents).toHaveLength(1);
    expect(paidEvents[0]).toMatchObject({
      aggregateId: "order-a",
      aggregateType: "order",
      eventType: "order.paid",
      sourceConnectionId: null,
      status: "pending",
    });
    expect(String(paidEvents[0]?.idempotencyHash)).toMatch(/^[0-9a-f]{64}$/u);

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }))
      .resolves.toEqual({ duplicate: true, processed: false, state: "paid_exact" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM domain_events
      WHERE shop_id = ? AND event_type = 'order.paid'
    `).get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("does not let unsigned outer envelope fields elevate signed non-paid evidence", async () => {
    const reference = "outer-envelope-tampering";
    const data = { ...bodyData(reference), code: "PENDING", desc: "Pending" };
    const body = {
      code: "00",
      data,
      signature: await createPayOSObjectSignature(data, ACTIVE_CHECKSUM_KEY),
      success: true,
    };

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }))
      .resolves.toEqual({ duplicate: false, processed: true, state: "pending" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "pending" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get()).toEqual({ status: "reserved" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
  });

  it("applies a signed full-refund reversal through the webhook runtime and replays it idempotently", async () => {
    const paid = await webhookBody("reversal-paid-before-refund", ACTIVE_CHECKSUM_KEY);
    await expect(processPayOSWebhook({ body: paid, env, webhookPublicId: "paywh-a" }))
      .resolves.toMatchObject({ duplicate: false, processed: true, state: "paid_exact" });

    const body = await reversalWebhookBody("signed-full-refund", ACTIVE_CHECKSUM_KEY);
    await expect(processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }))
      .resolves.toEqual({ duplicate: false, processed: true, state: "full_refund" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "refunded" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get())
      .toEqual({ state: "paid_exact" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM payment_reversal_events
      WHERE shop_id = ? AND order_id = 'order-a' AND decision = 'full_refund'
    `).get(SHOP_ID)).toEqual({ count: 1 });

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }))
      .resolves.toEqual({ duplicate: true, processed: false, state: "full_refund" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM payment_reversal_events
      WHERE shop_id = ? AND order_id = 'order-a'
    `).get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("ignores unsigned outer reversal hints and rejects invalid signed reversal kinds", async () => {
    const paid = await webhookBody("outer-reversal-paid-before-refund", ACTIVE_CHECKSUM_KEY);
    await expect(processPayOSWebhook({ body: paid, env, webhookPublicId: "paywh-a" }))
      .resolves.toMatchObject({ duplicate: false, processed: true, state: "paid_exact" });

    const signedPaymentData = bodyData("outer-only-reversal", ORDER_CODE, 100_000);
    const outerOnlyReversal = {
      code: "00",
      data: signedPaymentData,
      reversalKind: "refund",
      signature: await createPayOSObjectSignature(signedPaymentData, ACTIVE_CHECKSUM_KEY),
      success: true,
    };
    await expect(processPayOSWebhook({ body: outerOnlyReversal, env, webhookPublicId: "paywh-a" }))
      .resolves.toMatchObject({ duplicate: false, processed: false, state: "paid_exact" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "paid" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events WHERE shop_id = ?").get(SHOP_ID))
      .toEqual({ count: 0 });

    const invalid = await reversalWebhookBody("invalid-signed-reversal", ACTIVE_CHECKSUM_KEY, "void");
    await expect(processPayOSWebhook({ body: invalid, env, webhookPublicId: "paywh-a" }))
      .rejects.toMatchObject({ code: "webhook_invalid", status: 400 });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "paid" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events WHERE shop_id = ?").get(SHOP_ID))
      .toEqual({ count: 0 });
  });

  it("never fulfills signed evidence with a mismatched currency", async () => {
    const data = { ...bodyData("signed-currency-mismatch"), currency: "USD" };
    const body = {
      code: "00",
      data,
      signature: await createPayOSObjectSignature(data, ACTIVE_CHECKSUM_KEY),
      success: true,
    };

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }))
      .resolves.toEqual({ duplicate: false, processed: true, state: "identity_mismatch" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get())
      .toEqual({ state: "identity_mismatch" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "failed" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get())
      .toEqual({ status: "reserved" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
  });

  it("classifies concurrent first deliveries with one reference and different hashes as inconsistent", async () => {
    const reference = "concurrent-reference-conflict";
    const exact = await webhookBody(reference, ACTIVE_CHECKSUM_KEY);
    const conflictingData = bodyData(reference, ORDER_CODE, 90_000);
    const conflicting = {
      code: "00",
      data: conflictingData,
      signature: await createPayOSObjectSignature(conflictingData, ACTIVE_CHECKSUM_KEY),
      success: true,
    };
    let releaseReferenceReads = (): void => undefined;
    const bothEventsRecorded = new Promise<void>((resolve) => {
      releaseReferenceReads = resolve;
    });
    let referenceReads = 0;
    env = bindings(database, undefined, async (sql) => {
      if (!sql.includes("FROM payment_events WHERE integration_id = ? AND provider_event_reference = ?")) return;
      referenceReads += 1;
      if (referenceReads === 2) releaseReferenceReads();
      await bothEventsRecorded;
    });

    const outcomes = await Promise.all([
      processPayOSWebhook({ body: exact, env, webhookPublicId: "paywh-a" }),
      processPayOSWebhook({ body: conflicting, env, webhookPublicId: "paywh-a" }),
    ]);

    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "inconsistent" }),
      expect.objectContaining({ state: "inconsistent" }),
    ]));
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "inconsistent" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get()).toEqual({ status: "reserved" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_events WHERE integration_id = ? AND provider_event_reference = ?").get(INTEGRATION_ID, reference)).toEqual({ count: 2 });
  });

  it("blocks exact fulfillment when conflicting evidence is recorded after the initial reference read", async () => {
    const reference = "reference-conflict-before-fulfillment";
    const exact = await webhookBody(reference, ACTIVE_CHECKSUM_KEY);
    const conflictingData = bodyData(reference, ORDER_CODE, 90_000);
    const conflictingHash = await sha256Json(conflictingData);
    let injected = false;
    env = bindings(database, () => {
      if (injected) return;
      injected = true;
      database.prepare(`
        INSERT INTO payment_events (
          id, shop_id, payment_attempt_id, integration_id, provider,
          provider_event_reference, payload_hash, signature_verified,
          normalized_state, process_result, received_at
        ) VALUES (
          'event-conflicting-before-fulfillment', ?, 'attempt-a', ?, 'payos',
          ?, ?, 1, 'pending', 'received', ?
        )
      `).run(SHOP_ID, INTEGRATION_ID, reference, conflictingHash, NOW.toISOString());
    });

    await expect(processPayOSWebhook({ body: exact, env, webhookPublicId: "paywh-a" }))
      .resolves.toEqual({ duplicate: false, processed: true, state: "inconsistent" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "inconsistent" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get()).toEqual({ status: "reserved" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'order.paid'").get()).toEqual({ count: 0 });
  });

  it("claims concurrent exact duplicates idempotently", async () => {
    const reference = "concurrent-exact-duplicate";
    const body = await webhookBody(reference, ACTIVE_CHECKSUM_KEY);

    const outcomes = await Promise.all([
      processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }),
      processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }),
    ]);

    expect(outcomes).toEqual(expect.arrayContaining([
      { duplicate: false, processed: true, state: "paid_exact" },
      expect.objectContaining({ duplicate: true, processed: false }),
    ]));
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_events WHERE integration_id = ? AND provider_event_reference = ?").get(INTEGRATION_ID, reference)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 1 });
  });

  it("resolves the attempt credential when active and grace rows share a checksum key", async () => {
    database.prepare("UPDATE payment_attempts SET credential_id = ? WHERE id = 'attempt-a'")
      .run(SHARED_GRACE_CREDENTIAL_ID);
    await expect(processPayOSWebhook({
      body: await webhookBody("shared-checksum-grace-attempt", ACTIVE_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toMatchObject({ duplicate: false, processed: true, state: "paid_exact" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "paid_exact" });
  });

  it("rejects a pending credential for an active-credential attempt", async () => {
    await expect(processPayOSWebhook({
      body: await webhookBody("pending-credential-mismatch", PENDING_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).rejects.toMatchObject({ code: "webhook_identity_mismatch", status: 400 });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
  });

  it("never fulfills an attempt pinned to a pending credential", async () => {
    database.prepare("UPDATE payment_attempts SET credential_id = ? WHERE id = 'attempt-a'")
      .run(PENDING_CREDENTIAL_ID);
    await expect(processPayOSWebhook({
      body: await webhookBody("pending-owned-attempt", PENDING_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).rejects.toMatchObject({ code: "webhook_identity_mismatch", status: 400 });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
  });

  it("accepts a pending credential only for an unmapped provider validation probe", async () => {
    const body = await webhookBody("pending-validation-probe", PENDING_CHECKSUM_KEY, 654_321);
    await expect(processPayOSWebhook({
      body,
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toEqual({ duplicate: false, processed: false, state: "validation_probe" });
    await expect(processPayOSWebhook({
      body,
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toEqual({ duplicate: true, processed: false, state: "validation_probe" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM payment_events
      WHERE integration_id = ? AND provider_event_reference = ?
    `).get(INTEGRATION_ID, "pending-validation-probe")).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
  });

  it("fails closed when an authenticated unmapped event cannot be recorded", async () => {
    database.exec(`
      CREATE TRIGGER reject_unmapped_payment_event
      BEFORE INSERT ON payment_events
      WHEN NEW.payment_attempt_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced_unmapped_event_failure');
      END;
    `);

    await expect(processPayOSWebhook({
      body: await webhookBody("pending-validation-storage-failure", PENDING_CHECKSUM_KEY, 654_322),
      env,
      webhookPublicId: "paywh-a",
    })).rejects.toThrow("forced_unmapped_event_failure");
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
  });

  it("rejects an expired grace credential even for its former attempt", async () => {
    database.prepare("UPDATE payment_attempts SET credential_id = ? WHERE id = 'attempt-a'")
      .run(GRACE_CREDENTIAL_ID);
    database.prepare("UPDATE payment_credentials SET grace_ends_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(GRACE_CREDENTIAL_ID);
    await expect(processPayOSWebhook({
      body: await webhookBody("expired-grace-attempt", GRACE_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).rejects.toMatchObject({ code: "webhook_signature_invalid", status: 401 });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "pending" });
  });

  it("does not sell inventory when a later exact event follows an exception", async () => {
    await expect(processPayOSWebhook({
      body: await webhookBody("partial-before-exact", ACTIVE_CHECKSUM_KEY, ORDER_CODE, 50_000),
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toMatchObject({ processed: true, state: "partial" });

    await expect(processPayOSWebhook({
      body: await webhookBody("exact-after-partial", ACTIVE_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toMatchObject({ duplicate: false, processed: false, state: "partial" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "partial" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get()).toEqual({ status: "reserved" });
    expect(database.prepare("SELECT payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ fulfillmentStatus: "reserved", paymentStatus: "partial" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT process_result AS processResult FROM payment_events WHERE provider_event_reference = 'exact-after-partial'").get())
      .toEqual({ processResult: "state_conflict" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM domain_events
      WHERE shop_id = ? AND event_type = 'order.paid'
    `).get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("does not fulfill when an exception wins after the exact event reads pending state", async () => {
    let injected = false;
    env = bindings(database, () => {
      if (injected) return;
      injected = true;
      database.prepare("UPDATE payment_attempts SET state = 'partial' WHERE id = 'attempt-a'").run();
      database.prepare("UPDATE orders SET status = 'exception', payment_status = 'partial' WHERE id = 'order-a'").run();
    });

    await expect(processPayOSWebhook({
      body: await webhookBody("exception-wins-before-exact-batch", ACTIVE_CHECKSUM_KEY),
      env,
      webhookPublicId: "paywh-a",
    })).resolves.toEqual({ duplicate: false, processed: false, state: "partial" });

    expect(database.prepare("SELECT state, paid_event_id AS paidEventId FROM payment_attempts WHERE id = 'attempt-a'").get())
      .toEqual({ paidEventId: null, state: "partial" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get()).toEqual({ status: "reserved" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_jobs WHERE kind = 'order_paid'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT process_result AS processResult FROM payment_events WHERE provider_event_reference = 'exception-wins-before-exact-batch'").get())
      .toEqual({ processResult: "state_conflict" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM domain_events
      WHERE shop_id = ? AND event_type = 'order.paid'
    `).get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("resumes an exact event after a transient fulfillment failure", async () => {
    let failOnce = true;
    let batchCalls = 0;
    env = bindings(database, () => {
      batchCalls += 1;
      if (failOnce) {
        failOnce = false;
        throw new Error("transient_d1_failure");
      }
    });
    const reference = "retryable-exact-event";
    const body = await webhookBody(reference, ACTIVE_CHECKSUM_KEY);

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }))
      .rejects.toMatchObject({ code: "payment_fulfillment_failed", status: 500 });
    expect(database.prepare("SELECT state, paid_event_id AS paidEventId FROM payment_attempts WHERE id = 'attempt-a'").get())
      .toEqual({ paidEventId: null, state: "pending" });
    expect(database.prepare("SELECT process_result AS processResult, processed_at AS processedAt FROM payment_events WHERE provider_event_reference = ?").get(reference))
      .toEqual({ processResult: "retryable_error", processedAt: null });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get()).toEqual({ status: "reserved" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM domain_events
      WHERE shop_id = ? AND event_type = 'order.paid'
    `).get(SHOP_ID)).toEqual({ count: 0 });

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "paywh-a" }))
      .resolves.toEqual({ duplicate: false, processed: true, state: "paid_exact" });
    expect(batchCalls).toBe(2);
    const paidAttempt = database.prepare("SELECT state, paid_event_id AS paidEventId FROM payment_attempts WHERE id = 'attempt-a'").get() as { paidEventId: string | null; state: string };
    expect(paidAttempt.state).toBe("paid_exact");
    expect(paidAttempt.paidEventId).toEqual(expect.any(String));
    const fulfilledEvent = database.prepare("SELECT process_result AS processResult, processed_at AS processedAt FROM payment_events WHERE provider_event_reference = ?").get(reference) as { processResult: string; processedAt: string | null };
    expect(fulfilledEvent.processResult).toBe("fulfilled");
    expect(fulfilledEvent.processedAt).toEqual(expect.any(String));
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'inventory-key-a'").get()).toEqual({ status: "sold" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fulfillments").get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM domain_events
      WHERE shop_id = ? AND event_type = 'order.paid'
    `).get(SHOP_ID)).toEqual({ count: 1 });
  });
});
