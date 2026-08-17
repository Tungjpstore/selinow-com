import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createPaymentRemediationRequest, reviewPaymentRemediationRequest } from "../../src/lib/payments/remediation";
import { hmacToken, sha256Json } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-08-10T03:00:00.000Z";
const LATER = "2026-08-10T03:05:00.000Z";
const TOKEN_HASH_A = "a".repeat(43);
const TOKEN_HASH_A2 = "b".repeat(43);
const TOKEN_HASH_B = "c".repeat(43);
const GRANT_HASH_A = "d".repeat(43);
const GRANT_HASH_B = "e".repeat(43);
const SELLER = "seller-remediation-a";
const ADMIN_RISK = "admin-remediation-risk";
const ADMIN_SUPPORT = "admin-remediation-support";
const SHOP_A_PUBLIC = "shop-remediation-public-a";
const SHOP_B_PUBLIC = "shop-remediation-public-b";
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
    IDENTIFIER_HMAC_SECRET: "identifier-secret-for-remediation-tests",
    PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
    SESSION_SECRET: "session-secret",
  } as unknown as AppBindings;
  return { database, env };
}

function seedRuntime(): { database: DatabaseSync; env: AppBindings } {
  const runtime = createRuntime();
  const { database } = runtime;
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES
      ('${SELLER}', 'seller-remediation@example.test', 'Seller', 'active', '${NOW}', '${NOW}'),
      ('${ADMIN_RISK}', 'admin-risk@example.test', 'Risk Admin', 'active', '${NOW}', '${NOW}'),
      ('${ADMIN_SUPPORT}', 'admin-support@example.test', 'Support Admin', 'active', '${NOW}', '${NOW}');
    INSERT INTO platform_admins (user_id, role, status, created_at, updated_at) VALUES
      ('${ADMIN_RISK}', 'risk', 'active', '${NOW}', '${NOW}'),
      ('${ADMIN_SUPPORT}', 'support', 'active', '${NOW}', '${NOW}');
    UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = '${NOW}'
    WHERE id IN ('${ADMIN_RISK}', '${ADMIN_SUPPORT}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at) VALUES
      ('shop-a', '${SHOP_A_PUBLIC}', 'remediation-a', 'Remediation A', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}'),
      ('shop-b', '${SHOP_B_PUBLIC}', 'remediation-b', 'Remediation B', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-remediation', 'business', 'Business', '{}', '{}', '${NOW}', '${NOW}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES
      ('sub-remediation-a', 'shop-a', 'plan-remediation', 'active', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}'),
      ('sub-remediation-b', 'shop-b', 'plan-remediation', 'active', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at, member_public_id)
    VALUES ('shop-a', '${SELLER}', 'owner', 'active', '${NOW}', '${NOW}', 'mbr_remediation_owner_a');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at) VALUES
      ('product-a', 'shop-a', 'remediation-a', 'Remediation A', '', 'active', 'license_key', 1, '${NOW}', '${NOW}'),
      ('product-b', 'shop-b', 'remediation-b', 'Remediation B', '', 'active', 'license_key', 1, '${NOW}', '${NOW}');
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor, currency,
      min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES
      ('variant-a', 'shop-a', 'product-a', 'REM-A', 'Default', '{}', 1000, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-b', 'shop-b', 'product-b', 'REM-B', 'Default', '{}', 900, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}');
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status, payment_status,
      fulfillment_status, subtotal_minor, discount_minor, total_minor, currency,
      locale, checkout_subject_hash, order_token_hash, expires_at, created_at, updated_at
    ) VALUES
      ('order-a', 'order-remediation-public-a', 'shop-a', 'REM-A-1', 'web', 'pending_payment', 'unpaid',
        'reserved', 1000, 0, 1000, 'USD', 'en', 'subject-a', '${TOKEN_HASH_A}',
        '2026-08-10T05:00:00.000Z', '${NOW}', '${NOW}'),
      ('order-a2', 'order-remediation-public-a2', 'shop-a', 'REM-A-2', 'web', 'processing', 'paid',
        'reserved', 1000, 0, 1000, 'USD', 'en', 'subject-a2', '${TOKEN_HASH_A2}',
        '2026-08-10T05:00:00.000Z', '${NOW}', '${NOW}'),
      ('order-b', 'order-remediation-public-b', 'shop-b', 'REM-B-1', 'web', 'processing', 'paid',
        'reserved', 900, 0, 900, 'USD', 'en', 'subject-b', '${TOKEN_HASH_B}',
        '2026-08-10T05:00:00.000Z', '${NOW}', '${NOW}');
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title, variant_title,
      sku, unit_price_minor, quantity, line_total_minor, fulfillment_type, created_at
    ) VALUES
      ('item-a', 'shop-a', 'order-a', 'product-a', 'variant-a', 'Remediation A', 'Default', 'REM-A', 1000, 1, 1000, 'license_key', '${NOW}'),
      ('item-a2', 'shop-a', 'order-a2', 'product-a', 'variant-a', 'Remediation A', 'Default', 'REM-A', 1000, 1, 1000, 'license_key', '${NOW}'),
      ('item-b', 'shop-b', 'order-b', 'product-b', 'variant-b', 'Remediation B', 'Default', 'REM-B', 900, 1, 900, 'license_key', '${NOW}');
    INSERT INTO entitlement_resources (id, shop_id, resource_key, resource_type, status, created_at, updated_at)
    VALUES ('resource-a', 'shop-a', 'membership.remediation', 'membership', 'active', '${NOW}', '${NOW}');
    INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version, activation_condition,
      grant_quantity_per_unit, status, created_at, updated_at
    ) VALUES ('policy-a', 'shop-a', 'product-a', 'resource-a', 1, 'order_paid', 1, 'active', '${NOW}', '${NOW}');
    INSERT INTO order_item_entitlement_requirements (
      id, shop_id, order_id, order_item_id, policy_id, resource_id,
      policy_version, activation_condition, item_quantity, grant_quantity,
      entitlement_ttl_seconds, created_at
    ) VALUES ('requirement-a', 'shop-a', 'order-a', 'item-a', 'policy-a', 'resource-a', 1, 'order_paid', 1, 1, NULL, '${NOW}');
    INSERT INTO entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, resource_id,
      buyer_binding_hash, status, grant_quantity, version, created_at, updated_at
    ) VALUES ('entitlement-a', 'shop-a', 'order-a', 'item-a', 'requirement-a', 'resource-a',
      '${TOKEN_HASH_A}', 'pending', 1, 1, '${NOW}', '${NOW}');
    INSERT INTO entitlement_transitions (
      id, shop_id, entitlement_id, requirement_id, resource_id,
      entitlement_version, from_status, to_status, source_grant_id,
      reason_code, idempotency_key_hash, request_hash, actor_kind,
      occurred_at, created_at
    ) VALUES ('transition-created-a', 'shop-a', 'entitlement-a', 'requirement-a', 'resource-a',
      1, NULL, 'pending', NULL, 'checkout_reserved', '${GRANT_HASH_A}', '${GRANT_HASH_B}', 'system', '${NOW}', '${NOW}');
    UPDATE orders SET status = 'processing', payment_status = 'paid', paid_at = '${NOW}', updated_at = '${NOW}'
    WHERE id = 'order-a';
    UPDATE entitlements SET status = 'active', activated_at = '${NOW}', version = 2, updated_at = '${NOW}'
    WHERE id = 'entitlement-a' AND shop_id = 'shop-a' AND status = 'pending' AND version = 1;
    INSERT INTO inventory_batches (
      id, shop_id, variant_id, source, total_count, accepted_count, rejected_count,
      created_by_user_id, created_at
    ) VALUES
      ('batch-a', 'shop-a', 'variant-a', 'paste', 2, 2, 0, '${SELLER}', '${NOW}'),
      ('batch-b', 'shop-b', 'variant-b', 'paste', 1, 1, 0, '${SELLER}', '${NOW}');
    INSERT INTO inventory_keys (
      id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
      key_version, key_fingerprint, sold_order_item_id, sold_at, created_at
    ) VALUES
      ('key-sold-a', 'shop-a', 'variant-a', 'batch-a', 'sold', 'cipher', 'iv', 'v1', 'fingerprint-sold-a', 'item-a', '${NOW}', '${NOW}'),
      ('key-open-a', 'shop-a', 'variant-a', 'batch-a', 'available', 'cipher', 'iv', 'v1', 'fingerprint-open-a', NULL, NULL, '${NOW}'),
      ('key-sold-b', 'shop-b', 'variant-b', 'batch-b', 'sold', 'cipher', 'iv', 'v1', 'fingerprint-sold-b', 'item-b', '${NOW}', '${NOW}');
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
      created_at, updated_at
    ) VALUES ('integration-a', 'integration-remediation-public-a', 'webhook-remediation-a', 'shop-a', 'payos', 'active', 'verified', '${NOW}', '${NOW}');
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, created_by_user_id, created_at
    ) VALUES ('credential-a', 'shop-a', 'integration-a', 'payos', 'active', 1, 'v1',
      'cipher', 'iv', 'cipher', 'iv', 'cipher', 'iv', 'fingerprint-credential-a', '${SELLER}', '${NOW}');
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency, expected_description,
      expires_at, created_at, updated_at
    ) VALUES ('attempt-a', 'attempt-remediation-public-a', 'shop-a', 'order-a', 'integration-a',
      'credential-a', 'payos', 771001, 'paid_exact', 1000, 'USD', 'REM-A-1',
      '2026-08-10T05:00:00.000Z', '${NOW}', '${NOW}');
    INSERT INTO payment_events (
      id, shop_id, payment_attempt_id, integration_id, provider,
      provider_event_reference, payload_hash, signature_verified, normalized_state,
      process_result, received_at, processing_token, processing_started_at
    ) VALUES ('event-paid-a', 'shop-a', 'attempt-a', 'integration-a', 'payos',
      'paid-remediation-a', 'payload-a', 1, 'paid_exact', 'processing', '${NOW}', 'claim-a', '${NOW}');
    UPDATE payment_attempts SET paid_event_id = 'event-paid-a' WHERE id = 'attempt-a';
    INSERT INTO entitlement_grants (
      id, shop_id, entitlement_id, requirement_id, order_id, resource_id,
      source_kind, source_payment_event_id, idempotency_key_hash, request_hash,
      request_id, granted_quantity, created_at
    ) VALUES ('grant-a', 'shop-a', 'entitlement-a', 'requirement-a', 'order-a', 'resource-a',
      'payment_exact', 'event-paid-a', '${GRANT_HASH_A}', '${GRANT_HASH_B}', 'request-grant-a', 1, '${NOW}');
    INSERT INTO entitlement_transitions (
      id, shop_id, entitlement_id, requirement_id, resource_id,
      entitlement_version, from_status, to_status, source_grant_id,
      reason_code, idempotency_key_hash, request_hash, actor_kind,
      occurred_at, created_at
    ) VALUES ('transition-activation-a', 'shop-a', 'entitlement-a', 'requirement-a', 'resource-a',
      2, 'pending', 'active', 'grant-a', 'payment_exact_activated', '${GRANT_HASH_B}', '${GRANT_HASH_A}', 'system', '${NOW}', '${NOW}');
    UPDATE payment_events SET process_result = 'fulfilled', processing_token = NULL,
      processing_started_at = NULL, processed_at = '${NOW}' WHERE id = 'event-paid-a';
    INSERT INTO payment_exceptions (
      id, shop_id, order_id, payment_attempt_id, type, status, safe_evidence_json, created_at
    ) VALUES
      ('pex-a', 'shop-a', 'order-a', 'attempt-a', 'manual_review', 'open', '{"reason":"buyer_requested"}', '${NOW}'),
      ('pex-refund-a', 'shop-a', 'order-a', 'attempt-a', 'manual_review', 'open', '{"reason":"buyer_requested"}', '${NOW}'),
      ('pex-partial-a', 'shop-a', 'order-a', 'attempt-a', 'manual_review', 'open', '{"reason":"buyer_requested"}', '${NOW}'),
      ('pex-manual-a', 'shop-a', 'order-a', 'attempt-a', 'manual_review', 'open', '{"reason":"seller_requested"}', '${NOW}'),
      ('pex-fail-a', 'shop-a', 'order-a', 'attempt-a', 'manual_review', 'open', '{"reason":"buyer_requested"}', '${NOW}'),
      ('pex-requested-a', 'shop-a', 'order-a', 'attempt-a', 'manual_review', 'open', '{"reason":"seller_requested"}', '${NOW}');
    INSERT INTO payment_remediation_requests (
      id, public_id, shop_id, order_id, payment_exception_id, requested_by_user_id,
      kind, status, amount_minor, currency, reason_code, reviewed_by_user_id, reviewed_at,
      idempotency_key_hash, request_hash, version, created_at, updated_at
    ) VALUES
      ('prem-refund-a', 'prem-refund-a', 'shop-a', 'order-a', 'pex-refund-a', '${SELLER}',
        'refund', 'provider_pending', 0, 'USD', 'buyer_requested', '${ADMIN_RISK}', '${NOW}',
        'idem-remediation-refund-a', 'hash-remediation-refund-a', 2, '${NOW}', '${NOW}'),
      ('prem-partial-a', 'prem-partial-a', 'shop-a', 'order-a', 'pex-partial-a', '${SELLER}',
        'partial_refund', 'provider_pending', 0, 'USD', 'buyer_requested', '${ADMIN_RISK}', '${NOW}',
        'idem-remediation-partial-a', 'hash-remediation-partial-a', 2, '${NOW}', '${NOW}'),
      ('prem-manual-a', 'prem-manual-a', 'shop-a', 'order-a', 'pex-manual-a', '${SELLER}',
        'manual_review', 'provider_pending', 0, 'USD', 'seller_requested', '${ADMIN_RISK}', '${NOW}',
        'idem-remediation-manual-a', 'hash-remediation-manual-a', 2, '${NOW}', '${NOW}'),
      ('prem-fail-a', 'prem-fail-a', 'shop-a', 'order-a', 'pex-fail-a', '${SELLER}',
        'refund', 'provider_pending', 0, 'USD', 'buyer_requested', '${ADMIN_RISK}', '${NOW}',
        'idem-remediation-fail-a', 'hash-remediation-fail-a', 2, '${NOW}', '${NOW}'),
      ('prem-requested-a', 'prem-requested-a', 'shop-a', 'order-a', 'pex-requested-a', '${SELLER}',
        'manual_review', 'requested', 0, 'USD', 'seller_requested', NULL, NULL,
        'idem-remediation-requested-a', 'hash-remediation-requested-a', 1, '${NOW}', '${NOW}');
  `);
  return runtime;
}

function reviewInput(env: AppBindings, overrides: Partial<Parameters<typeof reviewPaymentRemediationRequest>[0]> = {}): Parameters<typeof reviewPaymentRemediationRequest>[0] {
  return {
    decision: "completed",
    env,
    expectedVersion: 2,
    idempotencyKey: "review-idempotency-default",
    now: new Date(LATER),
    requestId: "request-remediation-review-default",
    requestPublicId: "prem-refund-a",
    userId: ADMIN_RISK,
    ...overrides,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("payment remediation terminal review", () => {
  it("completes a refund request through the verified reversal engine exactly once", async () => {
    const { database, env } = seedRuntime();
    const completed = await reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-complete-refund-0001", requestId: "request-complete-refund-a" }));
    expect(completed).toMatchObject({ kind: "refund", status: "completed", version: 4 });
    expect(database.prepare(`
      SELECT status, completed_at IS NOT NULL AS completedAt,
        provider_reference_hash IS NOT NULL AS referenced, reviewed_by_user_id AS reviewedBy
      FROM payment_remediation_requests WHERE public_id = 'prem-refund-a'
    `).get()).toEqual({ completedAt: 1, referenced: 1, reviewedBy: ADMIN_RISK, status: "completed" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "refunded" });
    expect(database.prepare("SELECT status FROM entitlements WHERE id = 'entitlement-a'").get())
      .toEqual({ status: "revoked" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM entitlement_transitions WHERE reason_code = 'payment_reversal'").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT status, sold_order_item_id AS soldOrderItemId, sold_at AS soldAt FROM inventory_keys WHERE id = 'key-sold-a'").get())
      .toEqual({ soldAt: null, soldOrderItemId: null, status: "available" });
    expect(database.prepare(`
      SELECT decision, reversal_kind AS reversalKind, verification_method AS verificationMethod
      FROM payment_reversal_events WHERE shop_id = 'shop-a'
    `).get()).toEqual({ decision: "full_refund", reversalKind: "refund", verificationMethod: "direct_reconciliation" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'payment.remediation_completed' AND resource_id = 'prem-refund-a'").get())
      .toEqual({ count: 1 });

    const replay = await reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-complete-refund-0001", requestId: "request-complete-refund-retry" }));
    expect(replay.requestPublicId).toBe("prem-refund-a");
    expect(replay.status).toBe("completed");
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events WHERE shop_id = 'shop-a'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'payment.remediation_completed'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT status, sold_order_item_id AS soldOrderItemId FROM inventory_keys WHERE id = 'key-sold-a'").get())
      .toEqual({ soldOrderItemId: null, status: "available" });

    await expect(reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-complete-refund-0002", requestId: "request-complete-refund-late" })))
      .rejects.toMatchObject({ code: "payment_remediation_state_conflict", status: 409 });
  });

  it("rejects stale versions and wrong source states before applying any reversal side effect", async () => {
    const { database, env } = seedRuntime();
    await expect(reviewPaymentRemediationRequest(reviewInput(env, { expectedVersion: 1, idempotencyKey: "review-stale-version-0001", requestId: "request-stale-version" })))
      .rejects.toMatchObject({ code: "version_conflict", status: 409 });
    expect(database.prepare("SELECT status, version FROM payment_remediation_requests WHERE public_id = 'prem-refund-a'").get())
      .toEqual({ status: "provider_pending", version: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "paid" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'key-sold-a'").get()).toEqual({ status: "sold" });

    await expect(reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-requested-completed", requestId: "request-requested-completed", requestPublicId: "prem-requested-a" })))
      .rejects.toMatchObject({ code: "payment_remediation_state_conflict", status: 409 });
    await expect(reviewPaymentRemediationRequest(reviewInput(env, { decision: "failed", expectedVersion: 1, idempotencyKey: "review-requested-failed", requestId: "request-requested-failed", requestPublicId: "prem-requested-a" })))
      .rejects.toMatchObject({ code: "payment_remediation_state_conflict", status: 409 });
    await expect(reviewPaymentRemediationRequest(reviewInput(env, { decision: "refunded" as never, idempotencyKey: "review-invalid-decision", requestId: "request-invalid-decision" })))
      .rejects.toMatchObject({ code: "validation_failed", status: 400 });
    await expect(reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-seller-denied", requestId: "request-seller-denied", userId: SELLER })))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-support-denied", requestId: "request-support-denied", userId: ADMIN_SUPPORT })))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("restocks only the reversing tenant's keys and leaves a concurrent same-variant checkout untouched", async () => {
    const { database, env } = seedRuntime();
    (env.PLATFORM_DB as unknown as SqliteD1).beforeNextBatch(() => {
      database.prepare(`
        UPDATE inventory_keys
        SET status = 'sold', sold_order_item_id = 'item-a2', sold_at = ?
        WHERE id = 'key-open-a' AND shop_id = 'shop-a' AND status = 'available'
      `).run(LATER);
    });

    await expect(reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-restock-race-0001", requestId: "request-restock-race" })))
      .resolves.toMatchObject({ status: "completed" });

    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'key-sold-a'").get()).toEqual({ status: "available" });
    expect(database.prepare("SELECT status, sold_order_item_id AS soldOrderItemId FROM inventory_keys WHERE id = 'key-open-a'").get())
      .toEqual({ soldOrderItemId: "item-a2", status: "sold" });
    expect(database.prepare("SELECT status, sold_order_item_id AS soldOrderItemId FROM inventory_keys WHERE id = 'key-sold-b'").get())
      .toEqual({ soldOrderItemId: "item-b", status: "sold" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-b'").get())
      .toEqual({ paymentStatus: "paid" });
  });

  it("records failed decisions with audit evidence and without any reversal side effect", async () => {
    const { database, env } = seedRuntime();
    const failed = await reviewPaymentRemediationRequest(reviewInput(env, {
      decision: "failed",
      failureCode: "provider_declined_refund",
      idempotencyKey: "review-failed-refund-0001",
      requestId: "request-failed-refund",
      requestPublicId: "prem-fail-a",
    }));
    expect(failed).toMatchObject({ status: "failed", version: 4 });
    expect(database.prepare("SELECT status, failure_code AS failureCode FROM payment_remediation_requests WHERE public_id = 'prem-fail-a'").get())
      .toEqual({ failureCode: "provider_declined_refund", status: "failed" });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "paid" });
    expect(database.prepare("SELECT status FROM entitlements WHERE id = 'entitlement-a'").get()).toEqual({ status: "active" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'key-sold-a'").get()).toEqual({ status: "sold" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 0 });
    const audit = database.prepare("SELECT safe_metadata_json AS metadata FROM audit_logs WHERE action = 'payment.remediation_failed' AND resource_id = 'prem-fail-a'").get() as { metadata: string };
    expect(JSON.parse(audit.metadata)).toEqual({ decision: "failed", failureCode: "provider_declined_refund" });

    const replay = await reviewPaymentRemediationRequest(reviewInput(env, {
      decision: "failed",
      failureCode: "provider_declined_refund",
      idempotencyKey: "review-failed-refund-0001",
      requestId: "request-failed-refund-retry",
      requestPublicId: "prem-fail-a",
    }));
    expect(replay.status).toBe("failed");
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'payment.remediation_failed'").get()).toEqual({ count: 1 });
    await expect(reviewPaymentRemediationRequest(reviewInput(env, {
      decision: "failed",
      failureCode: "different_failure_code",
      idempotencyKey: "review-failed-refund-0001",
      requestId: "request-failed-refund-conflict",
      requestPublicId: "prem-fail-a",
    }))).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("completes partial refunds as manual settlements without reversal side effects", async () => {
    const { database, env } = seedRuntime();
    const completed = await reviewPaymentRemediationRequest(reviewInput(env, {
      idempotencyKey: "review-partial-complete-0001",
      requestId: "request-partial-complete",
      requestPublicId: "prem-partial-a",
    }));
    expect(completed).toMatchObject({ status: "completed", version: 4 });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get())
      .toEqual({ paymentStatus: "paid" });
    expect(database.prepare("SELECT status FROM inventory_keys WHERE id = 'key-sold-a'").get()).toEqual({ status: "sold" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 0 });
    const audit = database.prepare("SELECT safe_metadata_json AS metadata FROM audit_logs WHERE action = 'payment.remediation_completed' AND resource_id = 'prem-partial-a'").get() as { metadata: string };
    expect(JSON.parse(audit.metadata)).toEqual({ decision: "completed", manualPartialSettlement: true });

    const manual = await reviewPaymentRemediationRequest(reviewInput(env, {
      idempotencyKey: "review-manual-complete-0001",
      requestId: "request-manual-complete",
      requestPublicId: "prem-manual-a",
    }));
    expect(manual).toMatchObject({ status: "completed", version: 4 });
    const manualAudit = database.prepare("SELECT safe_metadata_json AS metadata FROM audit_logs WHERE action = 'payment.remediation_completed' AND resource_id = 'prem-manual-a'").get() as { metadata: string };
    expect(JSON.parse(manualAudit.metadata)).toEqual({ decision: "completed" });
  });

  it("fails completion closed when the order is no longer refundable", async () => {
    const { database, env } = seedRuntime();
    database.prepare("UPDATE orders SET payment_status = 'refunded', updated_at = ? WHERE id = 'order-a'").run(LATER);
    await expect(reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-blocked-completion", requestId: "request-blocked-completion" })))
      .rejects.toMatchObject({ code: "payment_remediation_completion_blocked", status: 409 });
    // The claim bump already committed before the reversal failed closed, so
    // the row stays provider_pending at the bumped version and is re-claimable.
    expect(database.prepare("SELECT status, version FROM payment_remediation_requests WHERE public_id = 'prem-refund-a'").get())
      .toEqual({ status: "provider_pending", version: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'payment.remediation_completed'").get()).toEqual({ count: 0 });
  });

  it("denies an un-enrolled owner/risk admin a terminal review until two-factor enrollment completes", async () => {
    const { database, env } = seedRuntime();
    const ADMIN_UNENROLLED = "admin-remediation-unenrolled";
    database.exec(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('${ADMIN_UNENROLLED}', 'admin-unenrolled-remediation@example.test', 'Unenrolled Risk Admin', 'active', '${NOW}', '${NOW}');
      INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
      VALUES ('${ADMIN_UNENROLLED}', 'risk', 'active', '${NOW}', '${NOW}');
    `);
    const input = reviewInput(env, {
      idempotencyKey: "review-unenrolled-0001",
      requestId: "request-unenrolled-review",
      userId: ADMIN_UNENROLLED,
    });
    // The fail-closed role lookup collapses un-enrolled admins to no role, so
    // the owner/risk check denies them before any remediation state moves.
    await expect(reviewPaymentRemediationRequest(input))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    expect(database.prepare("SELECT status, version FROM payment_remediation_requests WHERE public_id = 'prem-refund-a'").get())
      .toEqual({ status: "provider_pending", version: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'payment.remediation_%'").get())
      .toEqual({ count: 0 });

    database.prepare(`
      UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = ?
      WHERE id = '${ADMIN_UNENROLLED}'
    `).run(NOW);
    const completed = await reviewPaymentRemediationRequest(reviewInput(env, {
      idempotencyKey: "review-unenrolled-0001",
      requestId: "request-unenrolled-review-enrolled",
      userId: ADMIN_UNENROLLED,
    }));
    expect(completed).toMatchObject({ kind: "refund", status: "completed", version: 4 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'payment.remediation_completed' AND resource_id = 'prem-refund-a'").get())
      .toEqual({ count: 1 });
  });

  it("keeps seller refund creation rejected with a manual-settlement detail code", async () => {
    const { env } = seedRuntime();
    await expect(createPaymentRemediationRequest({
      amountMinor: 0,
      currency: "USD",
      env,
      exceptionPublicId: "pex-a",
      idempotencyKey: "seller-refund-attempt-0001",
      kind: "refund",
      now: new Date(NOW),
      reasonCode: "buyer_requested",
      requestId: "request-seller-refund",
      shopPublicId: SHOP_A_PUBLIC,
      userId: SELLER,
    })).rejects.toMatchObject({
      code: "provider_unsupported",
      issues: expect.arrayContaining(["payos_refund_api_unavailable"]) as readonly string[],
      status: 503,
    });
  });

  it("serializes concurrent terminal reviews so exactly one decision wins before money moves", async () => {
    const { database, env } = seedRuntime();
    const failedFirst = await reviewPaymentRemediationRequest(reviewInput(env, {
      decision: "failed",
      failureCode: "provider_declined_refund",
      idempotencyKey: "review-race-loser-first-0001",
      requestId: "request-race-loser-first",
      requestPublicId: "prem-refund-a",
    }));
    expect(failedFirst.status).toBe("failed");
    await expect(reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-race-winner-late-0001", requestId: "request-race-winner-late" })))
      .rejects.toMatchObject({ code: "payment_remediation_state_conflict", status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get()).toEqual({ paymentStatus: "paid" });

    // Second scenario: reviewer A's stale read passes the pre-checks, but a
    // concurrent reviewer B lands the claim and final failed batch before A's
    // claim batch runs — A must lose with version_conflict and no reversal.
    const { database: raceDatabase, env: raceEnv } = seedRuntime();
    (raceEnv.PLATFORM_DB as unknown as SqliteD1).beforeNextBatch(() => {
      raceDatabase.exec(`
        UPDATE payment_remediation_requests
        SET updated_at = '${LATER}', version = version + 1
        WHERE public_id = 'prem-refund-a' AND status = 'provider_pending' AND version = 2;
        UPDATE payment_remediation_requests
        SET status = 'failed', failure_code = 'provider_declined_refund', updated_at = '${LATER}', version = version + 1
        WHERE public_id = 'prem-refund-a' AND status = 'provider_pending' AND version = 3;
      `);
    });
    await expect(reviewPaymentRemediationRequest(reviewInput(raceEnv, { idempotencyKey: "review-race-completed-0001", requestId: "request-race-completed" })))
      .rejects.toMatchObject({ code: "version_conflict", status: 409 });
    expect(raceDatabase.prepare("SELECT status, failure_code AS failureCode FROM payment_remediation_requests WHERE public_id = 'prem-refund-a'").get())
      .toEqual({ failureCode: "provider_declined_refund", status: "failed" });
    expect(raceDatabase.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 0 });
    expect(raceDatabase.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get()).toEqual({ paymentStatus: "paid" });
    expect(raceDatabase.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'payment.remediation_completed'").get()).toEqual({ count: 0 });
  });

  it("recovers from a crash between claim and final via retry at the bumped version", async () => {
    const { database, env } = seedRuntime();
    // Simulate a process death after the claim batch committed: the row sits
    // at provider_pending with the bumped version and no idempotency record.
    database.prepare("UPDATE payment_remediation_requests SET version = 3, updated_at = ? WHERE public_id = 'prem-refund-a'").run(LATER);
    const recovered = await reviewPaymentRemediationRequest(reviewInput(env, {
      expectedVersion: 3,
      idempotencyKey: "review-crash-recovery-0001",
      requestId: "request-crash-recovery",
    }));
    expect(recovered).toMatchObject({ status: "completed", version: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT payment_status AS paymentStatus FROM orders WHERE id = 'order-a'").get()).toEqual({ paymentStatus: "refunded" });
  });

  it("replays terminal reviews recorded with the pre-failureCode request hash shape", async () => {
    const { database, env } = seedRuntime();
    const keyHash = await hmacToken(env.SESSION_SECRET, "payment-remediation-review-idempotency:v1", "review-legacy-hash-0001");
    const legacyHash = await sha256Json({ decision: "completed", expectedVersion: 2, requestPublicId: "prem-refund-a" });
    database.prepare(`
      INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ADMIN_RISK, "payment-remediation.review.v1:prem-refund-a", keyHash, legacyHash, JSON.stringify({ requestPublicId: "prem-refund-a" }), NOW, "2026-08-11T03:00:00.000Z");
    const replay = await reviewPaymentRemediationRequest(reviewInput(env, { idempotencyKey: "review-legacy-hash-0001", requestId: "request-legacy-hash" }));
    expect(replay.status).toBe("provider_pending");
    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_reversal_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT version FROM payment_remediation_requests WHERE public_id = 'prem-refund-a'").get()).toEqual({ version: 2 });
  });
});
