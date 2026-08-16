import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

const paymentCredentialMocks = vi.hoisted(() => ({
  loadCredentialById: vi.fn(),
  loadWebhookCredentials: vi.fn(),
}));

vi.mock("../../src/lib/payments/credentials", () => paymentCredentialMocks);

import { prepareGenericCheckoutEntitlementStatements } from "../../src/lib/commerce/entitlements";
import { prepareGeneratedLicenseRequestStatements } from "../../src/lib/commerce/generated-license";
import { hmacToken, sha256Json } from "../../src/lib/core/crypto";
import { applyVerifiedPaymentReversal } from "../../src/lib/commerce/payment-reversal";
import { AppError } from "../../src/lib/core/errors";
import { createPayOSObjectSignature } from "../../src/lib/payments/payos";
import { processPayOSWebhook } from "../../src/lib/payments/webhooks";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-07-30T02:00:00.000Z";
const LATER = "2026-07-30T02:01:00.000Z";
const HASH_A = "a".repeat(43);
const HASH_B = "b".repeat(43);
const HASH_C = "c".repeat(43);
const HASH_D = "d".repeat(43);
const HASH_E = "e".repeat(43);
const databases: DatabaseSync[] = [];

class SqliteStatement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  // D1's runtime contract carries the row type only through the return value.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  all<T>(): Promise<{ results: T[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) as T[] });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private beforeBatchHook: (() => void) | null = null;

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  beforeNextBatch(hook: () => void): void {
    this.beforeBatchHook = hook;
  }

  async batch(statements: readonly SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const hook = this.beforeBatchHook;
    this.beforeBatchHook = null;
    hook?.();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createRuntime(): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  const env = {
    APP_ENV: "local",
    IDENTIFIER_HMAC_SECRET: "identifier-secret-for-reversal-tests",
    PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
    SESSION_SECRET: "session-secret",
  } as unknown as AppBindings;
  return { database, env };
}

function seedBase(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-a', 'a@example.test', 'A', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES ('shop-a', 'shop-public-a', 'shop-a', 'A', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}'),
      ('shop-b', 'shop-public-b', 'shop-b', 'B', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES ('product-generic', 'shop-a', 'generic', 'Generic', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-private', 'shop-a', 'private', 'Private', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-key', 'shop-a', 'key', 'Key', '', 'active', 'license_key', 1, '${NOW}', '${NOW}');
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor, currency,
      min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES ('variant-generic', 'shop-a', 'product-generic', 'GEN', 'Default', '{}', 400, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-private', 'shop-a', 'product-private', 'PRI', 'Default', '{}', 400, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-key', 'shop-a', 'product-key', 'KEY', 'Default', '{}', 200, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}');
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status, payment_status,
      fulfillment_status, subtotal_minor, discount_minor, total_minor, currency,
      locale, checkout_subject_hash, order_token_hash, expires_at, created_at, updated_at
    ) VALUES ('order-a', 'order-public-a', 'shop-a', 'A-1', 'web', 'pending_payment', 'unpaid',
      'reserved', 1000, 0, 1000, 'USD', 'en', 'subject-a', '${HASH_A}',
      '2026-07-30T04:00:00.000Z', '${NOW}', '${NOW}');
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title, variant_title,
      sku, unit_price_minor, quantity, line_total_minor, fulfillment_type, created_at
    ) VALUES ('item-generic', 'shop-a', 'order-a', 'product-generic', 'variant-generic',
      'Generic', 'Default', 'GEN', 400, 1, 400, 'manual', '${NOW}'),
      ('item-private', 'shop-a', 'order-a', 'product-private', 'variant-private',
      'Private', 'Default', 'PRI', 400, 1, 400, 'manual', '${NOW}'),
      ('item-key', 'shop-a', 'order-a', 'product-key', 'variant-key',
      'Key', 'Default', 'KEY', 200, 1, 200, 'license_key', '${NOW}');
    INSERT INTO entitlement_resources (id, shop_id, resource_key, resource_type, status, created_at, updated_at)
    VALUES ('resource-active', 'shop-a', 'membership.active', 'membership', 'active', '${NOW}', '${NOW}'),
      ('resource-suspended', 'shop-a', 'membership.suspended', 'membership', 'active', '${NOW}', '${NOW}'),
      ('resource-pending', 'shop-a', 'membership.pending', 'membership', 'active', '${NOW}', '${NOW}'),
      ('resource-generated', 'shop-a', 'license.generated', 'generated_license', 'active', '${NOW}', '${NOW}');
    INSERT INTO generated_license_provider_connections (
      id, shop_id, provider_code, provider_environment, status,
      external_account_fingerprint, created_by_user_id, created_at, updated_at
    ) VALUES ('generated-connection-a', 'shop-a', 'fake.license', 'sandbox', 'active',
      '${HASH_A}', 'user-a', '${NOW}', '${NOW}');
    INSERT INTO generated_license_provider_credentials (
      id, shop_id, connection_id, provider_code, credential_version, status,
      key_version, endpoint_ciphertext_b64, endpoint_iv_b64,
      credential_ciphertext_b64, credential_iv_b64, endpoint_fingerprint,
      credential_fingerprint, created_by_user_id, activated_at, created_at, updated_at
    ) VALUES ('generated-credential-a', 'shop-a', 'generated-connection-a', 'fake.license',
      1, 'active', 'v1', 'endpoint-cipher', 'endpoint-iv', 'credential-cipher',
      'credential-iv', '${HASH_B}', '${HASH_C}', 'user-a', '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO generated_license_resource_bindings (
      id, shop_id, resource_id, connection_id, provider_code,
      generation_template_version, request_shape_hash, status,
      created_by_user_id, created_at, updated_at
    ) VALUES ('generated-binding-a', 'shop-a', 'resource-generated',
      'generated-connection-a', 'fake.license', 1, '${HASH_D}', 'active',
      'user-a', '${NOW}', '${NOW}');
    INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version, activation_condition,
      grant_quantity_per_unit, status, created_at, updated_at
    ) VALUES ('policy-active', 'shop-a', 'product-generic', 'resource-active', 1, 'order_paid', 1, 'active', '${NOW}', '${NOW}'),
      ('policy-suspended', 'shop-a', 'product-generic', 'resource-suspended', 1, 'order_paid', 1, 'active', '${NOW}', '${NOW}'),
      ('policy-pending', 'shop-a', 'product-generic', 'resource-pending', 1, 'order_paid', 1, 'active', '${NOW}', '${NOW}'),
      ('policy-generated', 'shop-a', 'product-generic', 'resource-generated', 1, 'order_paid', 1, 'active', '${NOW}', '${NOW}');
    INSERT INTO order_item_entitlement_requirements (
      id, shop_id, order_id, order_item_id, policy_id, resource_id,
      policy_version, activation_condition, item_quantity, grant_quantity,
      entitlement_ttl_seconds, created_at
    ) VALUES ('requirement-active', 'shop-a', 'order-a', 'item-generic', 'policy-active', 'resource-active', 1, 'order_paid', 1, 1, NULL, '${NOW}'),
      ('requirement-suspended', 'shop-a', 'order-a', 'item-generic', 'policy-suspended', 'resource-suspended', 1, 'order_paid', 1, 1, NULL, '${NOW}'),
      ('requirement-pending', 'shop-a', 'order-a', 'item-generic', 'policy-pending', 'resource-pending', 1, 'order_paid', 1, 1, NULL, '${NOW}'),
      ('requirement-generated', 'shop-a', 'order-a', 'item-generic', 'policy-generated', 'resource-generated', 1, 'order_paid', 1, 1, NULL, '${NOW}');
  `);
}

async function seedGenericEntitlements(database: DatabaseSync, env: AppBindings): Promise<void> {
  const statements = await prepareGenericCheckoutEntitlementStatements({
    database: env.PLATFORM_DB,
    isFree: false,
    nowIso: NOW,
    orderId: "order-a",
    orderPublicId: "order-public-a",
    orderTokenHash: HASH_A,
    requestHash: HASH_B,
    requirements: [
      { entitlementTtlSeconds: null, grantQuantity: 1, grantQuantityPerUnit: 1, itemQuantity: 1, orderItemId: "item-generic", policyId: "policy-active", policyVersion: 1, productId: "product-generic", resourceId: "resource-active", requirementId: "requirement-active" },
      { entitlementTtlSeconds: null, grantQuantity: 1, grantQuantityPerUnit: 1, itemQuantity: 1, orderItemId: "item-generic", policyId: "policy-suspended", policyVersion: 1, productId: "product-generic", resourceId: "resource-suspended", requirementId: "requirement-suspended" },
      { entitlementTtlSeconds: null, grantQuantity: 1, grantQuantityPerUnit: 1, itemQuantity: 1, orderItemId: "item-generic", policyId: "policy-pending", policyVersion: 1, productId: "product-generic", resourceId: "resource-pending", requirementId: "requirement-pending" },
      { entitlementTtlSeconds: null, grantQuantity: 1, grantQuantityPerUnit: 1, itemQuantity: 1, orderItemId: "item-generic", policyId: "policy-generated", policyVersion: 1, productId: "product-generic", resourceId: "resource-generated", requirementId: "requirement-generated" },
    ],
    shopId: "shop-a",
    sourceIdempotencyHash: HASH_C,
  });
  await (env.PLATFORM_DB as unknown as SqliteD1).batch(statements as unknown as SqliteStatement[]);

  database.exec(`
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
      created_at, updated_at
    ) VALUES ('integration-a', 'integration-public-a', 'webhook-a', 'shop-a', 'payos', 'active', 'verified', '${NOW}', '${NOW}');
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, created_by_user_id, created_at
    ) VALUES ('credential-a', 'shop-a', 'integration-a', 'payos', 'active', 1, 'v1',
      'cipher', 'iv', 'cipher', 'iv', 'cipher', 'iv', 'fingerprint-a', 'user-a', '${NOW}');
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency, expected_description,
      expires_at, created_at, updated_at
    ) VALUES ('attempt-a', 'attempt-public-a', 'shop-a', 'order-a', 'integration-a',
      'credential-a', 'payos', 70001, 'paid_exact', 1000, 'USD', 'A',
      '2026-07-30T04:00:00.000Z', '${NOW}', '${NOW}');
    INSERT INTO payment_events (
      id, shop_id, payment_attempt_id, integration_id, provider,
      provider_event_reference, payload_hash, signature_verified, normalized_state,
      process_result, received_at, processing_token, processing_started_at
    ) VALUES ('event-paid-a', 'shop-a', 'attempt-a', 'integration-a', 'payos',
      'paid-a', 'payload-a', 1, 'paid_exact', 'processing', '${NOW}', 'claim-a', '${NOW}');
    UPDATE payment_attempts SET paid_event_id = 'event-paid-a' WHERE id = 'attempt-a';
    UPDATE orders SET status = 'processing', payment_status = 'paid', paid_at = '${NOW}', updated_at = '${NOW}' WHERE id = 'order-a';
  `);

  for (const requirementId of ["requirement-active", "requirement-suspended", "requirement-generated"]) {
    const entitlement = database.prepare("SELECT id, resource_id AS resourceId FROM entitlements WHERE requirement_id = ?").get(requirementId) as { id: string; resourceId: string };
    const grantId = `grant-${requirementId}`;
    const grantIdempotencyHash = requirementId === "requirement-active"
      ? HASH_B
      : requirementId === "requirement-suspended" ? HASH_C : HASH_E;
    const transitionIdempotencyHash = requirementId === "requirement-active"
      ? HASH_C
      : requirementId === "requirement-suspended" ? HASH_D : HASH_A;
    database.prepare(`
      UPDATE entitlements
      SET status = 'active', activated_at = ?, version = 2, updated_at = ?
      WHERE id = ? AND shop_id = 'shop-a' AND status = 'pending' AND version = 1
    `).run(NOW, NOW, entitlement.id);
    database.prepare(`
      INSERT INTO entitlement_grants (
        id, shop_id, entitlement_id, requirement_id, order_id, resource_id,
        source_kind, source_payment_event_id, idempotency_key_hash, request_hash,
        request_id, granted_quantity, created_at
      ) VALUES (?, 'shop-a', ?, ?, 'order-a', ?, 'payment_exact', 'event-paid-a',
        ?, ?, ?, 1, ?)
    `).run(grantId, entitlement.id, requirementId, entitlement.resourceId, grantIdempotencyHash, HASH_C, `request-${requirementId}`, NOW);
    database.prepare(`
      INSERT INTO entitlement_transitions (
        id, shop_id, entitlement_id, requirement_id, resource_id,
        entitlement_version, from_status, to_status, source_grant_id,
        reason_code, idempotency_key_hash, request_hash, actor_kind,
        occurred_at, created_at
      ) VALUES (?, 'shop-a', ?, ?, ?, 2, 'pending', 'active', ?,
        'payment_exact_activated', ?, ?, 'system', ?, ?)
    `).run(`transition-${requirementId}`, entitlement.id, requirementId, entitlement.resourceId, grantId, transitionIdempotencyHash, HASH_D, NOW, NOW);
    if (requirementId === "requirement-generated") {
      const requestStatements = await prepareGeneratedLicenseRequestStatements({
        database: env.PLATFORM_DB,
        entitlementGrantId: grantId,
        entitlementId: entitlement.id,
        nowIso: NOW,
        orderId: "order-a",
        requirementId,
        shopId: "shop-a",
      });
      await (env.PLATFORM_DB as unknown as SqliteD1).batch(requestStatements as unknown as SqliteStatement[]);
    }
  }
  const suspended = database.prepare("SELECT id FROM entitlements WHERE requirement_id = 'requirement-suspended'").get() as { id: string };
  database.prepare(`
    UPDATE entitlements SET status = 'suspended', suspended_at = ?, version = 3, updated_at = ?
    WHERE id = ? AND shop_id = 'shop-a'
  `).run(LATER, LATER, suspended.id);
  database.prepare(`
    INSERT INTO entitlement_transitions (
      id, shop_id, entitlement_id, requirement_id, resource_id,
      entitlement_version, from_status, to_status, reason_code,
      idempotency_key_hash, request_hash, actor_kind, occurred_at, created_at
    ) SELECT 'transition-suspended', shop_id, id, requirement_id, resource_id,
      3, 'active', 'suspended', 'seller_suspended', ?, ?, 'system', ?, ?
    FROM entitlements WHERE id = ?
  `).run(HASH_B, HASH_C, LATER, LATER, suspended.id);
  database.prepare(`
    UPDATE payment_events SET process_result = 'fulfilled', processing_token = NULL,
      processing_started_at = NULL, processed_at = ? WHERE id = 'event-paid-a'
  `).run(LATER);
}

function seedPrivateAndFulfillmentHistory(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO digital_assets (id, shop_id, kind, status, created_by_user_id, created_at, updated_at)
    VALUES ('asset-a', 'shop-a', 'private_file', 'active', 'user-a', '${NOW}', '${NOW}');
    INSERT INTO digital_asset_versions (
      id, shop_id, asset_id, version, object_key, filename_sanitized, content_type,
      byte_size, content_sha256, object_etag, status, created_by_user_id, created_at, updated_at
    ) VALUES ('asset-version-a', 'shop-a', 'asset-a', 1,
      'private-digital-assets/shop-a/asset-a/version-a', 'guide.pdf', 'application/pdf',
      10, '${HASH_A}', 'etag-a', 'active', 'user-a', '${NOW}', '${NOW}');
    INSERT INTO product_fulfillment_policies (
      id, shop_id, product_id, capability, policy_version, asset_version_id,
      max_downloads, grant_ttl_seconds, status, created_by_user_id, created_at, updated_at
    ) VALUES ('private-policy-a', 'shop-a', 'product-private', 'private_file', 1,
      'asset-version-a', 3, 600, 'active', 'user-a', '${NOW}', '${NOW}');
    INSERT INTO order_item_fulfillment_requirements (
      id, shop_id, order_id, order_item_id, capability, policy_id, policy_version,
      asset_version_id, max_downloads, grant_ttl_seconds, created_at
    ) VALUES ('private-requirement-a', 'shop-a', 'order-a', 'item-private', 'private_file',
      'private-policy-a', 1, 'asset-version-a', 3, 600, '${NOW}');
    INSERT INTO digital_entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, asset_version_id,
      buyer_binding_hash, status, max_downloads, download_count, version, created_at, updated_at
    ) VALUES ('private-entitlement-a', 'shop-a', 'order-a', 'item-private',
      'private-requirement-a', 'asset-version-a', '${HASH_A}', 'active', 3, 0, 1, '${NOW}', '${NOW}');
    INSERT INTO delivery_grants (
      id, shop_id, entitlement_id, order_id, order_item_id, asset_version_id,
      buyer_binding_hash, token_nonce, token_hash, token_key_version,
      issuance_key_hash, request_hash, status, expires_at, version, created_at, updated_at
    ) VALUES ('grant-consumed-a', 'shop-a', 'private-entitlement-a', 'order-a', 'item-private',
      'asset-version-a', '${HASH_A}', '${HASH_B}', '${HASH_C}', 'identifier-hmac-v1',
      '${HASH_B}', '${HASH_C}', 'active', '2026-07-30T02:09:00.000Z', 1, '${NOW}', '${NOW}');
    INSERT INTO delivery_grant_consumptions (
      id, shop_id, entitlement_id, grant_id, order_id, asset_version_id,
      request_id, outcome, created_at
    ) VALUES ('consumption-a', 'shop-a', 'private-entitlement-a', 'grant-consumed-a',
      'order-a', 'asset-version-a', 'request-consumption-a', 'served', '${LATER}');
    UPDATE delivery_grants SET status = 'consumed', consumed_at = '${LATER}', version = 2, updated_at = '${LATER}'
    WHERE id = 'grant-consumed-a';
    UPDATE digital_entitlements SET download_count = 1, version = 2, updated_at = '${LATER}'
    WHERE id = 'private-entitlement-a';
    INSERT INTO delivery_grants (
      id, shop_id, entitlement_id, order_id, order_item_id, asset_version_id,
      buyer_binding_hash, token_nonce, token_hash, token_key_version,
      issuance_key_hash, request_hash, status, expires_at, version, created_at, updated_at
    ) VALUES ('grant-active-a', 'shop-a', 'private-entitlement-a', 'order-a', 'item-private',
      'asset-version-a', '${HASH_A}', '${HASH_C}', '${HASH_D}', 'identifier-hmac-v1',
      '${HASH_D}', '${HASH_A}', 'active', '2026-07-30T02:09:00.000Z', 1, '${LATER}', '${LATER}');
    INSERT INTO delivery_grant_claims (id, shop_id, grant_id, created_at, lease_expires_at)
    VALUES ('claim-active-a', 'shop-a', 'grant-active-a', '${LATER}', '2026-07-30T02:06:00.000Z');
    INSERT INTO inventory_batches (
      id, shop_id, variant_id, source, total_count, accepted_count, rejected_count,
      created_by_user_id, created_at
    ) VALUES ('batch-a', 'shop-a', 'variant-key', 'paste', 1, 1, 0, 'user-a', '${NOW}');
    INSERT INTO inventory_keys (
      id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
      key_version, key_fingerprint, sold_order_item_id, sold_at, created_at
    ) VALUES ('key-a', 'shop-a', 'variant-key', 'batch-a', 'sold', 'cipher', 'iv',
      'v1', 'fingerprint-key-a', 'item-key', '${NOW}', '${NOW}');
    INSERT INTO fulfillments (
      id, shop_id, order_id, fulfillment_type, state, idempotency_key,
      created_at, fulfilled_at
    ) VALUES ('fulfillment-a', 'shop-a', 'order-a', 'digital_keys', 'fulfilled',
      'fulfillment-idempotency-a', '${NOW}', '${NOW}');
    INSERT INTO fulfillment_items (
      id, shop_id, fulfillment_id, order_item_id, inventory_key_id, delivered_at, created_at
    ) VALUES ('fulfillment-item-a', 'shop-a', 'fulfillment-a', 'item-key', 'key-a', '${NOW}', '${NOW}');
  `);
}

function reversalInput(env: AppBindings, overrides: Partial<Parameters<typeof applyVerifiedPaymentReversal>[0]> = {}): Parameters<typeof applyVerifiedPaymentReversal>[0] {
  return {
    amountMinor: 1000,
    credentialId: "credential-a",
    credentialVersion: 1,
    currency: "USD",
    evidenceHash: HASH_A,
    env,
    idempotencyKey: "reversal-idempotency-a",
    integrationId: "integration-a",
    occurredAt: "2026-07-30T02:10:00.000Z",
    orderId: "order-a",
    originalPaymentEventId: "event-paid-a",
    paymentAttemptId: "attempt-a",
    provider: "payos",
    providerReference: "provider-reversal-reference-a",
    requestId: "request-reversal-a",
    reversalKind: "refund",
    shopId: "shop-a",
    verificationMethod: "signed_webhook",
    verified: true,
    ...overrides,
  };
}

async function signedRefundBody(checksumKey: string, reversalKind: string = "refund"): Promise<Record<string, unknown>> {
  const data = {
    amount: 1_000,
    code: "00",
    currency: "USD",
    description: "A",
    orderCode: 70_001,
    reference: "provider-reversal-webhook-a",
    reversalKind,
    transactionDateTime: LATER,
  };
  return {
    code: "00",
    data,
    signature: await createPayOSObjectSignature(data, checksumKey),
    success: true,
  };
}

async function reversalRequestHashes(input: Parameters<typeof applyVerifiedPaymentReversal>[0]): Promise<{ providerReferenceHash: string; idempotencyKeyHash: string; requestHash: string }> {
  const providerReferenceHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "payment-reversal-reference", input.providerReference);
  const idempotencyKeyHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "payment-reversal-idempotency", input.idempotencyKey);
  const requestHash = await sha256Json({
    amountMinor: input.amountMinor,
    credentialId: input.credentialId,
    credentialVersion: input.credentialVersion,
    currency: input.currency,
    integrationId: input.integrationId,
    occurredAt: input.occurredAt,
    orderId: input.orderId,
    originalPaymentEventId: input.originalPaymentEventId,
    paymentAttemptId: input.paymentAttemptId,
    provider: input.provider,
    providerReferenceHash,
    reversalKind: input.reversalKind,
    shopId: input.shopId,
    verificationMethod: input.verificationMethod,
    purpose: "payment-reversal-request",
  });
  return { providerReferenceHash, idempotencyKeyHash, requestHash };
}

async function seededRuntime(): Promise<{ database: DatabaseSync; env: AppBindings }> {
  const runtime = createRuntime();
  seedBase(runtime.database);
  await seedGenericEntitlements(runtime.database, runtime.env);
  seedPrivateAndFulfillmentHistory(runtime.database);
  return runtime;
}

type GeneratedLicenseRequestState = "pending" | "retryable" | "processing" | "reconcile_pending";

function advanceGeneratedLicenseRequest(database: DatabaseSync, state: Exclude<GeneratedLicenseRequestState, "pending">): { requestId: string; attemptCount: number } {
  const request = database.prepare(`
    SELECT id, request_hash AS requestHash, credential_version AS credentialVersion
    FROM generated_license_requests
    WHERE shop_id = 'shop-a' AND order_id = 'order-a'
    LIMIT 1
  `).get() as { requestId?: string; id: string; requestHash: string; credentialVersion: number };
  database.prepare(`
    UPDATE generated_license_requests
    SET status = 'processing', attempt_count = 1,
      next_attempt_at = ?, lease_token = ?, lease_expires_at = ?,
      last_safe_error_code = NULL, version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = 'shop-a' AND status = 'pending'
  `).run(
    LATER,
    "lease-generated-a",
    LATER,
    LATER,
    request.id,
  );
  if (state !== "processing") {
    database.prepare(`
      UPDATE generated_license_requests
      SET status = ?, lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = 'shop-a' AND status = 'processing'
    `).run(
      state,
      state === "reconcile_pending" ? null : "provider_timeout",
      LATER,
      request.id,
    );
  }
  database.prepare(`
    INSERT INTO generated_license_attempts (
      id, shop_id, request_id, attempt_no, action_kind, credential_version,
      request_hash, outcome, safe_error_code, occurred_at, created_at
    ) VALUES (?, 'shop-a', ?, 1, 'generate', ?, ?, ?, ?, ?, ?)
  `).run(
    `generated-attempt-${state}`,
    request.id,
    request.credentialVersion,
    request.requestHash,
    state === "reconcile_pending" || state === "processing" ? "ambiguous" : "retryable",
    state === "retryable" ? "provider_timeout" : null,
    LATER,
    LATER,
  );
  return { attemptCount: 1, requestId: request.id };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("verified payment reversal access revocation", () => {
  it("routes a signed PayOS full refund into generated request and entitlement revocation", async () => {
    const { database, env } = await seededRuntime();
    paymentCredentialMocks.loadCredentialById.mockResolvedValue({
      credentials: {
        apiKey: "payos-api-key-for-test",
        checksumKey: "payos-checksum-key-for-test",
        clientId: "payos-client-id-for-test",
      },
      row: {
        credentialId: "credential-a",
        integrationId: "integration-a",
        shopId: "shop-a",
        version: 1,
      },
    });
    const body = await signedRefundBody("payos-checksum-key-for-test");

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "webhook-a" }))
      .resolves.toEqual({ duplicate: false, processed: true, state: "full_refund" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "refunded" });
    expect(database.prepare("SELECT status, COUNT(*) AS count FROM entitlements GROUP BY status").all())
      .toEqual([{ count: 4, status: "revoked" }]);
    expect(database.prepare(`
      SELECT status, canceled_at IS NOT NULL AS canceled,
        lease_token AS leaseToken, last_safe_error_code AS lastSafeErrorCode
      FROM generated_license_requests WHERE shop_id = 'shop-a' AND order_id = 'order-a'
    `).get()).toEqual({
      canceled: 1,
      lastSafeErrorCode: "payment_reversal",
      leaseToken: null,
      status: "canceled",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events WHERE shop_id = 'shop-a'").get())
      .toEqual({ count: 1 });

    await expect(processPayOSWebhook({ body, env, webhookPublicId: "webhook-a" }))
      .resolves.toEqual({ duplicate: true, processed: false, state: "full_refund" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events WHERE shop_id = 'shop-a'").get())
      .toEqual({ count: 1 });
  });

  it("atomically refunds and revokes live access while preserving fulfillment and consumption history", async () => {
    const { database, env } = await seededRuntime();
    const result = await applyVerifiedPaymentReversal(reversalInput(env));

    expect(result).toMatchObject({ decision: "full_refund", duplicate: false, revoked: true });
    expect(database.prepare("SELECT payment_status AS paymentStatus, status, fulfillment_status AS fulfillmentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ fulfillmentStatus: "reserved", paymentStatus: "refunded", status: "processing" });
    expect(database.prepare("SELECT status, COUNT(*) AS count FROM entitlements GROUP BY status").all())
      .toEqual([{ count: 4, status: "revoked" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM entitlement_transitions WHERE reason_code = 'payment_reversal'").get())
      .toEqual({ count: 4 });
    expect(database.prepare(`
      SELECT status, canceled_at IS NOT NULL AS canceled,
        lease_token AS leaseToken, last_safe_error_code AS lastSafeErrorCode
      FROM generated_license_requests
    `).get()).toEqual({ canceled: 1, lastSafeErrorCode: "payment_reversal", leaseToken: null, status: "canceled" });
    expect(database.prepare("SELECT status, download_count AS downloadCount FROM digital_entitlements WHERE id = 'private-entitlement-a'").get())
      .toEqual({ downloadCount: 1, status: "revoked" });
    expect(database.prepare("SELECT id, status FROM delivery_grants ORDER BY id").all()).toEqual([
      { id: "grant-active-a", status: "revoked" },
      { id: "grant-consumed-a", status: "consumed" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_consumptions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT status, sold_order_item_id AS soldOrderItemId, sold_at AS soldAt FROM inventory_keys WHERE id = 'key-a'").get())
      .toEqual({ soldAt: null, soldOrderItemId: null, status: "available" });
    expect(database.prepare("SELECT state FROM fulfillments WHERE id = 'fulfillment-a'").get()).toEqual({ state: "fulfilled" });
    const ledger = database.prepare("SELECT provider_reference_hash AS providerReferenceHash, evidence_hash AS evidenceHash FROM payment_reversal_events").get() as Record<string, unknown>;
    expect(JSON.stringify(ledger)).not.toContain("provider-reversal-reference-a");

    const replay = await applyVerifiedPaymentReversal(reversalInput(env));
    expect(replay).toMatchObject({ decision: "full_refund", duplicate: true, reversalId: result.reversalId, revoked: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 1 });
  });

  it.each([
    "pending",
    "retryable",
    "processing",
    "reconcile_pending",
  ] satisfies readonly GeneratedLicenseRequestState[])("cancels a %s generated-license request locally without provider I/O", async (state) => {
    const { database, env } = await seededRuntime();
    const initial = database.prepare(`
      SELECT id, version FROM generated_license_requests
      WHERE shop_id = 'shop-a' AND order_id = 'order-a'
      LIMIT 1
    `).get() as { id: string; version: number };
    const history = state === "pending"
      ? { attemptCount: 0, requestId: initial.id }
      : advanceGeneratedLicenseRequest(database, state);
    const before = database.prepare(`
      SELECT version FROM generated_license_requests WHERE id = ? AND shop_id = 'shop-a'
    `).get(history.requestId) as { version: number };
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(applyVerifiedPaymentReversal(reversalInput(env, {
      idempotencyKey: `generated-reversal-${state}`,
      providerReference: `generated-provider-reference-${state}`,
      requestId: `generated-reversal-request-${state}`,
    }))).resolves.toMatchObject({ decision: "full_refund", revoked: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(database.prepare(`
      SELECT status, canceled_at IS NOT NULL AS canceled,
        lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
        last_safe_error_code AS lastSafeErrorCode, version
      FROM generated_license_requests WHERE id = ? AND shop_id = 'shop-a'
    `).get(history.requestId)).toEqual({
      canceled: 1,
      lastSafeErrorCode: "payment_reversal",
      leaseExpiresAt: null,
      leaseToken: null,
      status: "canceled",
      version: before.version + 1,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM generated_license_attempts
      WHERE request_id = ? AND shop_id = 'shop-a'
    `).get(history.requestId)).toEqual({ count: history.attemptCount });
    expect(database.prepare(`
      SELECT entitlements.status
      FROM generated_license_requests
      INNER JOIN entitlements
        ON entitlements.id = generated_license_requests.entitlement_id
        AND entitlements.shop_id = generated_license_requests.shop_id
      WHERE generated_license_requests.id = ?
    `).get(history.requestId)).toEqual({ status: "revoked" });
  });

  it("revokes an active generated-license artifact while retaining immutable request and attempt history", async () => {
    const { database, env } = await seededRuntime();
    const request = database.prepare(`
      SELECT id, entitlement_id AS entitlementId, request_hash AS requestHash,
        credential_version AS credentialVersion
      FROM generated_license_requests
      WHERE shop_id = 'shop-a' AND order_id = 'order-a'
      LIMIT 1
    `).get() as { credentialVersion: number; entitlementId: string; id: string; requestHash: string };
    database.prepare(`
      UPDATE generated_license_requests
      SET status = 'processing', attempt_count = 1,
        lease_token = 'lease-generated-success', lease_expires_at = ? ,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = 'shop-a' AND status = 'pending'
    `).run(LATER, LATER, request.id);
    database.prepare(`
      UPDATE generated_license_requests
      SET status = 'succeeded', attempt_count = 1,
        lease_token = NULL, lease_expires_at = NULL,
        provider_reference_hash = ?, evidence_hash = ?, succeeded_at = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = 'shop-a' AND status = 'processing'
    `).run(HASH_B, HASH_C, LATER, LATER, request.id);
    database.prepare(`
      INSERT INTO generated_license_attempts (
        id, shop_id, request_id, attempt_no, action_kind, credential_version,
        request_hash, provider_reference_hash, evidence_hash, outcome,
        occurred_at, created_at
      ) VALUES ('generated-attempt-success', 'shop-a', ?, 1, 'generate', ?, ?,
        ?, ?, 'success', ?, ?)
    `).run(request.id, request.credentialVersion, request.requestHash, HASH_B, HASH_C, LATER, LATER);
    database.prepare(`
      INSERT INTO generated_license_artifacts (
        id, shop_id, request_id, entitlement_id, ordinal, ciphertext_b64,
        iv_b64, key_version, artifact_fingerprint, format, status, created_at
      ) VALUES ('generated-artifact-a', 'shop-a', ?, ?, 1, 'artifact-ciphertext',
        'artifact-iv', 'v1', ?, 'text', 'active', ?)
    `).run(request.id, request.entitlementId, HASH_D, LATER);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(applyVerifiedPaymentReversal(reversalInput(env, {
      idempotencyKey: "generated-artifact-reversal-a",
      providerReference: "generated-artifact-provider-reference-a",
      requestId: "generated-artifact-reversal-request-a",
    }))).resolves.toMatchObject({ decision: "full_refund", revoked: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(database.prepare(`
      SELECT status, canceled_at AS canceledAt, attempt_count AS attemptCount
      FROM generated_license_requests WHERE id = ?
    `).get(request.id)).toEqual({ attemptCount: 1, canceledAt: null, status: "succeeded" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM generated_license_attempts WHERE request_id = ?
    `).get(request.id)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT status, revoked_at IS NOT NULL AS revoked,
        ciphertext_b64 AS ciphertext, key_version AS keyVersion
      FROM generated_license_artifacts WHERE id = 'generated-artifact-a'
    `).get()).toEqual({
      ciphertext: "artifact-ciphertext",
      keyVersion: "v1",
      revoked: 1,
      status: "revoked",
    });
  });

  it("records partial and mismatched evidence for manual review without revoking", async () => {
    for (const input of [
      { amountMinor: 400, expectedDecision: "partial", suffix: "partial" },
      { amountMinor: 1000, currency: "EUR", expectedDecision: "mismatch", suffix: "mismatch" },
    ] as const) {
      const { database, env } = await seededRuntime();
      const result = await applyVerifiedPaymentReversal(reversalInput(env, {
        amountMinor: input.amountMinor,
        currency: input.currency ?? "USD",
        idempotencyKey: `reversal-idempotency-${input.suffix}`,
        providerReference: `provider-reference-${input.suffix}`,
        requestId: `request-reversal-${input.suffix}`,
      }));
      expect(result).toMatchObject({ decision: input.expectedDecision, revoked: false });
      expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get()).toEqual({ paymentStatus: "paid" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'revoked'").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM payment_exceptions WHERE type = 'manual_review' AND status = 'open'").get()).toEqual({ count: 1 });
      database.close();
      databases.splice(databases.indexOf(database), 1);
    }
  });

  it("fails closed for unverified, cross-tenant and conflicting replay evidence", async () => {
    const { database, env } = await seededRuntime();
    await expect(applyVerifiedPaymentReversal(reversalInput(env, { verified: false })))
      .rejects.toMatchObject({ code: "payment_reversal_unverified" });
    await expect(applyVerifiedPaymentReversal(reversalInput(env, { shopId: "shop-b" })))
      .rejects.toMatchObject({ code: "payment_reversal_not_admissible" });
    const first = await applyVerifiedPaymentReversal(reversalInput(env, { amountMinor: 400 }));
    expect(first.decision).toBe("partial");
    await expect(applyVerifiedPaymentReversal(reversalInput(env, {
      amountMinor: 400,
      evidenceHash: HASH_B,
    }))).rejects.toMatchObject({ code: "payment_reversal_conflict", status: 409 });
    const conflict = applyVerifiedPaymentReversal(reversalInput(env, { amountMinor: 500 }));
    await expect(conflict).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.code === "payment_reversal_conflict");
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 1 });
  });

  it("rejects invalid reversal evidence metadata at the runtime boundary before D1 access", async () => {
    const inaccessibleDatabase = new Proxy({}, {
      get() {
        throw new Error("D1 must not be accessed for invalid reversal enums");
      },
    }) as D1Database;
    const env = {
      IDENTIFIER_HMAC_SECRET: "identifier-secret-for-reversal-tests",
      PLATFORM_DB: inaccessibleDatabase,
    } as AppBindings;

    await expect(applyVerifiedPaymentReversal(reversalInput(env, {
      reversalKind: "void" as never,
    }))).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["reversal_kind_invalid"],
      status: 400,
    });
    await expect(applyVerifiedPaymentReversal(reversalInput(env, {
      verificationMethod: "return_url" as never,
    }))).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["verification_method_invalid"],
      status: 400,
    });
    await expect(applyVerifiedPaymentReversal(reversalInput(env, {
      evidenceHash: "not-a-sha256-base64url-hash",
    }))).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["evidence_hash_invalid"],
      status: 400,
    });
    await expect(applyVerifiedPaymentReversal(reversalInput(env, {
      occurredAt: "2026-07-30",
    }))).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["occurred_at_invalid"],
      status: 400,
    });
  });

  it("reloads an exact competing ledger row after a uniqueness race and conflicts on evidence drift", async () => {
    for (const evidenceConflict of [false, true]) {
      const { database, env } = await seededRuntime();
      const input = reversalInput(env, {
        amountMinor: 400,
        evidenceHash: HASH_A,
        idempotencyKey: `reversal-race-${evidenceConflict ? "conflict" : "exact"}`,
        providerReference: `provider-race-${evidenceConflict ? "conflict" : "exact"}`,
        requestId: `request-race-${evidenceConflict ? "conflict" : "exact"}`,
      });
      const hashes = await reversalRequestHashes(input);
      (env.PLATFORM_DB as unknown as SqliteD1).beforeNextBatch(() => {
        database.prepare(`
          INSERT INTO payment_reversal_events (
            id, shop_id, order_id, payment_attempt_id, integration_id, credential_id,
            credential_version, original_payment_event_id, provider, reversal_kind,
            decision, verification_method, evidence_verified, amount_minor,
            expected_amount_minor, currency, expected_currency, provider_reference_hash,
            provider_reference_hash_key_version, evidence_hash, idempotency_key_hash,
            request_hash, reason_code, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?,
            'identifier-hmac-v1', ?, ?, ?, ?, ?, ?)
        `).run(
          `prev-race-${evidenceConflict ? "conflict" : "exact"}`,
          input.shopId,
          input.orderId,
          input.paymentAttemptId,
          input.integrationId,
          input.credentialId,
          input.credentialVersion,
          input.originalPaymentEventId,
          input.provider,
          input.reversalKind,
          "partial",
          input.verificationMethod,
          input.amountMinor,
          1000,
          input.currency,
          input.currency,
          hashes.providerReferenceHash,
          evidenceConflict ? HASH_B : input.evidenceHash,
          hashes.idempotencyKeyHash,
          hashes.requestHash,
          "payment_reversal_partial",
          input.occurredAt,
          NOW,
        );
      });
      if (evidenceConflict) {
        await expect(applyVerifiedPaymentReversal(input)).rejects.toMatchObject({ code: "payment_reversal_conflict", status: 409 });
      } else {
        await expect(applyVerifiedPaymentReversal(input)).resolves.toMatchObject({ decision: "partial", duplicate: true, reversalId: "prev-race-exact", revoked: false });
      }
      expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 1 });
      database.close();
      databases.splice(databases.indexOf(database), 1);
    }
  });

  it("serializes a concurrent private consumption and generic activation before revoking remaining access", async () => {
    const { database, env } = await seededRuntime();
    const pending = database.prepare("SELECT id, resource_id AS resourceId FROM entitlements WHERE requirement_id = 'requirement-pending'").get() as { id: string; resourceId: string };
    (env.PLATFORM_DB as unknown as SqliteD1).beforeNextBatch(() => {
      database.exec(`
        INSERT INTO delivery_grant_consumptions (
          id, shop_id, entitlement_id, grant_id, order_id, asset_version_id,
          request_id, outcome, created_at
        ) VALUES ('consumption-race', 'shop-a', 'private-entitlement-a', 'grant-active-a',
          'order-a', 'asset-version-a', 'request-consumption-race', 'served',
          '2026-07-30T02:02:00.000Z');
        UPDATE delivery_grants
        SET status = 'consumed', consumed_at = '2026-07-30T02:02:00.000Z',
          version = version + 1, updated_at = '2026-07-30T02:02:00.000Z'
        WHERE id = 'grant-active-a' AND shop_id = 'shop-a' AND status = 'active';
        UPDATE digital_entitlements
        SET download_count = download_count + 1, version = version + 1,
          updated_at = '2026-07-30T02:02:00.000Z'
        WHERE id = 'private-entitlement-a' AND shop_id = 'shop-a' AND status = 'active';
        UPDATE payment_events SET process_result = 'processing', processed_at = NULL,
          processing_token = 'claim-race', processing_started_at = '2026-07-30T02:02:00.000Z'
        WHERE id = 'event-paid-a';
      `);
      database.prepare(`
        UPDATE entitlements SET status = 'active', activated_at = ?, version = 2, updated_at = ?
        WHERE id = ? AND shop_id = 'shop-a' AND status = 'pending' AND version = 1
      `).run("2026-07-30T02:02:00.000Z", "2026-07-30T02:02:00.000Z", pending.id);
      database.prepare(`
        INSERT INTO entitlement_grants (
          id, shop_id, entitlement_id, requirement_id, order_id, resource_id,
          source_kind, source_payment_event_id, idempotency_key_hash, request_hash,
          request_id, granted_quantity, created_at
        ) VALUES ('grant-requirement-pending-race', 'shop-a', ?, 'requirement-pending',
          'order-a', ?, 'payment_exact', 'event-paid-a', ?, ?,
          'request-concurrent-activation', 1, '2026-07-30T02:02:00.000Z')
      `).run(pending.id, pending.resourceId, HASH_D, HASH_A);
      database.prepare(`
        INSERT INTO entitlement_transitions (
          id, shop_id, entitlement_id, requirement_id, resource_id,
          entitlement_version, from_status, to_status, source_grant_id,
          reason_code, idempotency_key_hash, request_hash, actor_kind,
          occurred_at, created_at
        ) VALUES ('transition-pending-race', 'shop-a', ?, 'requirement-pending', ?,
          2, 'pending', 'active', 'grant-requirement-pending-race',
          'payment_exact_activated', ?, ?, 'system',
          '2026-07-30T02:02:00.000Z', '2026-07-30T02:02:00.000Z')
      `).run(pending.id, pending.resourceId, HASH_A, HASH_B);
      database.exec(`
        UPDATE payment_events SET process_result = 'fulfilled', processed_at = '2026-07-30T02:02:00.000Z',
          processing_token = NULL, processing_started_at = NULL WHERE id = 'event-paid-a';
      `);
    });

    const result = await applyVerifiedPaymentReversal(reversalInput(env));
    expect(result.revoked).toBe(true);
    expect(database.prepare("SELECT status FROM delivery_grants WHERE id = 'grant-active-a'").get()).toEqual({ status: "consumed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_consumptions").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT status, download_count AS downloadCount FROM digital_entitlements WHERE id = 'private-entitlement-a'").get())
      .toEqual({ downloadCount: 2, status: "revoked" });
    expect(database.prepare(`
      SELECT transitions.from_status AS fromStatus, transitions.to_status AS toStatus
      FROM entitlement_transitions AS transitions
      INNER JOIN entitlements ON entitlements.id = transitions.entitlement_id
      WHERE entitlements.requirement_id = 'requirement-pending'
      ORDER BY transitions.entitlement_version DESC LIMIT 1
    `).get()).toEqual({ fromStatus: "active", toStatus: "revoked" });
  });

  it("prevents any post-refund private consumption or newly materialized entitlement", async () => {
    const { database, env } = await seededRuntime();
    await applyVerifiedPaymentReversal(reversalInput(env));
    expect(() => database.prepare(`
      INSERT INTO delivery_grant_consumptions (
        id, shop_id, entitlement_id, grant_id, order_id, asset_version_id,
        request_id, outcome, created_at
      ) VALUES ('consumption-after-refund', 'shop-a', 'private-entitlement-a',
        'grant-active-a', 'order-a', 'asset-version-a', 'request-after-refund',
        'served', '2026-07-30T02:03:00.000Z')
    `).run()).toThrow("private_file_consumption_scope_mismatch");

    database.exec(`
      INSERT INTO entitlement_resources (id, shop_id, resource_key, resource_type, status, created_at, updated_at)
      VALUES ('resource-after-refund', 'shop-a', 'membership.after-refund', 'membership', 'active', '${LATER}', '${LATER}');
      INSERT INTO product_entitlement_policies (
        id, shop_id, product_id, resource_id, policy_version, activation_condition,
        grant_quantity_per_unit, status, created_at, updated_at
      ) VALUES ('policy-after-refund', 'shop-a', 'product-generic', 'resource-after-refund',
        1, 'order_paid', 1, 'active', '${LATER}', '${LATER}');
      INSERT INTO order_item_entitlement_requirements (
        id, shop_id, order_id, order_item_id, policy_id, resource_id,
        policy_version, activation_condition, item_quantity, grant_quantity,
        created_at
      ) VALUES ('requirement-after-refund', 'shop-a', 'order-a', 'item-generic',
        'policy-after-refund', 'resource-after-refund', 1, 'order_paid', 1, 1, '${LATER}');
    `);
    expect(() => database.prepare(`
      INSERT INTO entitlements (
        id, shop_id, order_id, order_item_id, requirement_id, resource_id,
        buyer_binding_hash, status, grant_quantity, version, created_at, updated_at
      ) VALUES ('entitlement-after-refund', 'shop-a', 'order-a', 'item-generic',
        'requirement-after-refund', 'resource-after-refund', ?, 'pending', 1, 1, ?, ?)
    `).run(HASH_A, LATER, LATER)).toThrow("entitlement_activation_scope_mismatch");
  });

  it("applies an exact verified chargeback through the same revocation fence", async () => {
    const { database, env } = await seededRuntime();
    database.prepare("UPDATE digital_entitlements SET status = 'suspended', version = version + 1, updated_at = ? WHERE id = 'private-entitlement-a'").run(LATER);
    const result = await applyVerifiedPaymentReversal(reversalInput(env, {
      idempotencyKey: "chargeback-idempotency-a",
      providerReference: "provider-chargeback-reference-a",
      requestId: "request-chargeback-a",
      reversalKind: "chargeback",
    }));
    expect(result).toMatchObject({ decision: "chargeback", revoked: true });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get()).toEqual({ paymentStatus: "refunded" });
    expect(database.prepare("SELECT status FROM digital_entitlements WHERE id = 'private-entitlement-a'").get()).toEqual({ status: "revoked" });
    expect(database.prepare("SELECT reason_code AS reasonCode FROM payment_reversal_events").get()).toEqual({ reasonCode: "payment_chargeback" });
  });

  it("rolls back the reversal batch when another state transition wins first", async () => {
    const { database, env } = await seededRuntime();
    (env.PLATFORM_DB as unknown as SqliteD1).beforeNextBatch(() => {
      database.prepare("UPDATE orders SET payment_status = 'refunded', updated_at = ? WHERE id = 'order-a' AND shop_id = 'shop-a'").run("2026-07-30T02:02:00.000Z");
    });
    await expect(applyVerifiedPaymentReversal(reversalInput(env)))
      .rejects.toMatchObject({ code: "payment_reversal_state_conflict", status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'revoked'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT status FROM delivery_grants WHERE id = 'grant-active-a'").get()).toEqual({ status: "active" });
  });
});
