import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resolveExternalOrderChannelAttribution } from "../../src/lib/channels/attribution";
import { executeCanonicalCheckoutTransaction } from "../../src/lib/commerce/checkout-transaction";
import {
  expireGenericEntitlements,
  prepareGenericPaidActivationStatements,
} from "../../src/lib/commerce/entitlements";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-07-30T04:00:00.000Z";
const SHOP_ID = "shop-generic-a";
const OTHER_SHOP_ID = "shop-generic-b";
const PRODUCT_ID = "product-generic-a";
const VARIANT_ID = "variant-generic-a";
const RESOURCE_ID = "resource-generic-a";
const POLICY_ID = "policy-generic-a-v1";
const BUYER_BINDING_HASH = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const HASH_A = "a".repeat(43);
const HASH_B = "b".repeat(43);
const HASH_C = "c".repeat(43);
const HASH_D = "d".repeat(43);
const databases: DatabaseSync[] = [];

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first(): Promise<Record<string, unknown> | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as Record<string, unknown> | undefined) ?? null);
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

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: readonly SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
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

function createDatabase(): { database: DatabaseSync; d1: SqliteD1 } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return { database, d1: new SqliteD1(database) };
}

function seedBase(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-generic-a', 'generic-a@example.test', 'Generic A', 'active', '${NOW}', '${NOW}'),
      ('user-generic-b', 'generic-b@example.test', 'Generic B', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('${SHOP_ID}', 'shop-public-generic-a', 'generic-a', 'Generic A', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}'),
      ('${OTHER_SHOP_ID}', 'shop-public-generic-b', 'generic-b', 'Generic B', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('${SHOP_ID}', 'user-generic-a', 'owner', 'active', '${NOW}', '${NOW}'),
      ('${OTHER_SHOP_ID}', 'user-generic-b', 'owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES ('${PRODUCT_ID}', '${SHOP_ID}', 'generic-product', 'Generic product', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-generic-b', '${OTHER_SHOP_ID}', 'generic-product-b', 'Generic product B', '', 'active', 'manual', 1, '${NOW}', '${NOW}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES ('${VARIANT_ID}', '${SHOP_ID}', '${PRODUCT_ID}', 'GENERIC-A', 'Default', '{}', 0, 'USD', 1, 5, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-generic-b', '${OTHER_SHOP_ID}', 'product-generic-b', 'GENERIC-B', 'Default', '{}', 0, 'USD', 1, 5, 'active', 1, '${NOW}', '${NOW}');
    INSERT INTO entitlement_resources (id, shop_id, resource_key, resource_type, status, created_at, updated_at)
    VALUES ('${RESOURCE_ID}', '${SHOP_ID}', 'membership.basic', 'membership', 'active', '${NOW}', '${NOW}'),
      ('resource-generic-b', '${OTHER_SHOP_ID}', 'membership.basic', 'membership', 'active', '${NOW}', '${NOW}');
    INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version, activation_condition,
      grant_quantity_per_unit, entitlement_ttl_seconds, status, created_at, updated_at
    ) VALUES ('${POLICY_ID}', '${SHOP_ID}', '${PRODUCT_ID}', '${RESOURCE_ID}', 1, 'order_paid', 2, 3600, 'active', '${NOW}', '${NOW}'),
      ('policy-generic-b-v1', '${OTHER_SHOP_ID}', 'product-generic-b', 'resource-generic-b', 1, 'order_paid', 1, NULL, 'active', '${NOW}', '${NOW}');
  `);
}

function seedOrder(database: DatabaseSync, input: {
  id: string;
  itemId: string;
  totalMinor: number;
  paymentStatus: "paid" | "unpaid";
  status: "processing" | "pending_payment";
  paidAt: string | null;
}): void {
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'web', ?, ?, 'unfulfilled', ?, 0, ?, 'USD', 'en', ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    `order-public-${input.id}`,
    SHOP_ID,
    `ORDER-${input.id}`,
    input.status,
    input.paymentStatus,
    input.totalMinor,
    input.totalMinor,
    `subject-${input.id}`,
    BUYER_BINDING_HASH,
    "2026-07-30T06:00:00.000Z",
    input.paidAt,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title, variant_title,
      sku, unit_price_minor, quantity, line_total_minor, fulfillment_type, created_at
    ) VALUES (?, ?, ?, ?, ?, 'Generic product', 'Default', 'GENERIC-A', ?, 2, ?, 'manual', ?)
  `).run(input.itemId, SHOP_ID, input.id, PRODUCT_ID, VARIANT_ID, input.totalMinor / 2, input.totalMinor, NOW);
  database.prepare(`
    INSERT INTO order_item_entitlement_requirements (
      id, shop_id, order_id, order_item_id, policy_id, resource_id, policy_version,
      activation_condition, item_quantity, grant_quantity, entitlement_ttl_seconds, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'order_paid', 2, 4, 3600, ?)
  `).run(`req-${input.id}`, SHOP_ID, input.id, input.itemId, POLICY_ID, RESOURCE_ID, NOW);
}

function bindings(database: DatabaseSync): AppBindings {
  return {
    APP_ENV: "local",
    PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
    SESSION_SECRET: "session-secret",
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
  } as unknown as AppBindings;
}

function seedCart(database: DatabaseSync, cartId: string, channel: "web" | "telegram", subjectHash: string): void {
  database.prepare(`
    INSERT INTO carts (id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'en', 'active', '2026-07-30T06:00:00.000Z', ?, ?)
  `).run(cartId, SHOP_ID, channel, subjectHash, NOW, NOW);
  database.prepare("INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (?, ?, ?, 1)").run(cartId, SHOP_ID, VARIANT_ID);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("generic entitlement migration and service", () => {
  it("keeps the six-table graph tenant-bound and immutable", () => {
    const { database } = createDatabase();
    seedBase(database);
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%entitlement%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual([
      "digital_entitlements",
      "entitlement_grants",
      "entitlement_resources",
      "entitlement_transitions",
      "entitlements",
      "order_item_entitlement_requirements",
      "product_entitlement_policies",
    ]);

    expect(() => database.prepare(`INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version, activation_condition,
      grant_quantity_per_unit, status, created_at, updated_at
    ) VALUES ('cross-policy', ?, ?, ?, 1, 'order_paid', 1, 'active', ?, ?)`)
      .run(SHOP_ID, "product-generic-b", RESOURCE_ID, NOW, NOW)).toThrow();
    expect(() => database.prepare("UPDATE entitlement_resources SET resource_key = 'changed', version = 2, updated_at = ? WHERE id = ?").run(NOW, RESOURCE_ID)).toThrow("entitlement_resource_identity_immutable");
  });

  it("materializes free active and paid pending states, then only exact payment activates", async () => {
    const { database, d1 } = createDatabase();
    seedBase(database);
    seedOrder(database, { id: "order-free-generic", itemId: "item-free-generic", paidAt: NOW, paymentStatus: "paid", status: "processing", totalMinor: 0 });
    seedOrder(database, { id: "order-paid-generic", itemId: "item-paid-generic", paidAt: null, paymentStatus: "unpaid", status: "pending_payment", totalMinor: 1000 });
    const free = await import("../../src/lib/commerce/entitlements");
    const freeStatements = await free.prepareGenericCheckoutEntitlementStatements({
      database: d1 as unknown as AppBindings["PLATFORM_DB"],
      isFree: true,
      nowIso: NOW,
      orderId: "order-free-generic",
      orderPublicId: "order-public-order-free-generic",
      orderTokenHash: BUYER_BINDING_HASH,
      requestHash: BUYER_BINDING_HASH,
      requirements: [{ entitlementTtlSeconds: 3600, grantQuantity: 4, grantQuantityPerUnit: 2, itemQuantity: 2, orderItemId: "item-free-generic", policyId: POLICY_ID, policyVersion: 1, productId: PRODUCT_ID, resourceId: RESOURCE_ID, requirementId: "req-order-free-generic" }],
      shopId: SHOP_ID,
      sourceIdempotencyHash: BUYER_BINDING_HASH,
    });
    await d1.batch(freeStatements as unknown as readonly SqliteStatement[]);
    expect(database.prepare("SELECT status, version FROM entitlements WHERE id LIKE 'ent_%'").get()).toEqual({ status: "active", version: 1 });
    expect(database.prepare("SELECT source_kind, granted_quantity FROM entitlement_grants").get()).toEqual({ granted_quantity: 4, source_kind: "free_checkout" });

    const paidStatements = await free.prepareGenericCheckoutEntitlementStatements({
      database: d1 as unknown as AppBindings["PLATFORM_DB"],
      isFree: false,
      nowIso: NOW,
      orderId: "order-paid-generic",
      orderPublicId: "order-public-order-paid-generic",
      orderTokenHash: BUYER_BINDING_HASH,
      requestHash: BUYER_BINDING_HASH,
      requirements: [{ entitlementTtlSeconds: 3600, grantQuantity: 4, grantQuantityPerUnit: 2, itemQuantity: 2, orderItemId: "item-paid-generic", policyId: POLICY_ID, policyVersion: 1, productId: PRODUCT_ID, resourceId: RESOURCE_ID, requirementId: "req-order-paid-generic" }],
      shopId: SHOP_ID,
      sourceIdempotencyHash: HASH_B,
    });
    await d1.batch(paidStatements as unknown as readonly SqliteStatement[]);
    expect(database.prepare("SELECT status, version FROM entitlements WHERE requirement_id = 'req-order-paid-generic'").get()).toEqual({ status: "pending", version: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM entitlement_grants WHERE requirement_id = 'req-order-paid-generic'").get()).toEqual({ count: 0 });

    database.exec(`
      INSERT INTO payment_integrations (id, public_id, webhook_public_id, shop_id, provider, status, webhook_status, created_at, updated_at)
      VALUES ('integration-generic', 'integration-public-generic', 'webhook-generic', '${SHOP_ID}', 'payos', 'active', 'verified', '${NOW}', '${NOW}');
      INSERT INTO payment_credentials (id, shop_id, integration_id, provider, status, version, key_version,
        client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64, api_key_iv_b64,
        checksum_key_ciphertext_b64, checksum_key_iv_b64, credential_fingerprint, created_by_user_id, created_at)
      VALUES ('credential-generic', '${SHOP_ID}', 'integration-generic', 'payos', 'active', 1, 'v1',
        'cipher', 'iv', 'cipher', 'iv', 'cipher', 'iv', 'fingerprint-generic', 'user-generic-a', '${NOW}');
      INSERT INTO payment_attempts (id, public_id, shop_id, order_id, integration_id, credential_id, provider,
        provider_order_code, state, expected_amount_minor, currency, expected_description, expires_at, created_at, updated_at)
      VALUES ('attempt-generic', 'attempt-public-generic', '${SHOP_ID}', 'order-paid-generic', 'integration-generic', 'credential-generic', 'payos', 77001, 'paid_exact', 1000, 'USD', 'Generic', '2026-07-30T06:00:00.000Z', '${NOW}', '${NOW}');
      INSERT INTO payment_events (id, shop_id, payment_attempt_id, integration_id, provider, provider_event_reference,
        payload_hash, signature_verified, normalized_state, process_result, received_at, processing_token, processing_started_at)
      VALUES ('event-generic', '${SHOP_ID}', 'attempt-generic', 'integration-generic', 'payos', 'reference-generic',
        'payload-generic', 1, 'paid_exact', 'received', '${NOW}', 'claim-generic', '${NOW}');
      UPDATE payment_attempts SET paid_event_id = 'event-generic'
      WHERE id = 'attempt-generic' AND shop_id = '${SHOP_ID}';
      UPDATE orders SET status = 'processing', payment_status = 'paid', paid_at = '${NOW}', updated_at = '${NOW}' WHERE id = 'order-paid-generic';
    `);
    const activation = await prepareGenericPaidActivationStatements({
      database: d1 as unknown as AppBindings["PLATFORM_DB"],
      eventId: "event-generic",
      nowIso: NOW,
      orderId: "order-paid-generic",
      requestHash: HASH_C,
      shopId: SHOP_ID,
      sourceIdempotencyHash: HASH_D,
    });
    const activationResults = await d1.batch(activation as unknown as readonly SqliteStatement[]);
    if (activationResults.length === 0) throw new Error("activation_statements_empty");
    expect(database.prepare("SELECT status, version FROM entitlements WHERE requirement_id = 'req-order-paid-generic'").get()).toEqual({ status: "active", version: 2 });
    expect(database.prepare("SELECT source_kind, source_payment_event_id FROM entitlement_grants WHERE requirement_id = 'req-order-paid-generic'").get()).toEqual({ source_kind: "payment_exact", source_payment_event_id: "event-generic" });
  });

  it("snapshots and activates the same generic policy for website, Telegram, and fake channels", async () => {
    const { database } = createDatabase();
    seedBase(database);
    const env = bindings(database);
    const channels = [
      { cartChannel: "web" as const, code: "website", connectionId: null, eventIdempotencyKey: HASH_A },
      { cartChannel: "telegram" as const, code: "telegram", connectionId: null, eventIdempotencyKey: HASH_B },
      { attribution: resolveExternalOrderChannelAttribution({ adapterVersion: 1, channelCode: "fake.third", legacySourceChannel: "web" }), cartChannel: "web" as const, code: "fake", connectionId: null, eventIdempotencyKey: HASH_C },
    ];
    for (const channel of channels) {
      const cartId = `cart-generic-${channel.code}`;
      const subjectHash = `${channel.code}-${BUYER_BINDING_HASH}`;
      const orderId = `order-channel-${channel.code}`;
      seedCart(database, cartId, channel.cartChannel, subjectHash);
      const result = await executeCanonicalCheckoutTransaction({
        cartId,
        cartSnapshot: { discountCode: null },
        channel: channel.attribution === undefined
          ? { code: channel.code, connectionId: channel.connectionId }
          : { attribution: channel.attribution, code: channel.attribution.channelCode, connectionId: channel.connectionId },
        checkoutRequestHash: HASH_B,
        checkoutSubjectHash: subjectHash,
        currency: "USD",
        customer: channel.code === "website"
          ? {
            emailNormalized: "buyer@example.test",
            id: "customer-generic-website",
            kind: "upsert_email",
            locale: "en",
            maskedEmail: "b***@example.test",
          }
          : { kind: "anonymous", maskedEmail: null },
        discountMinor: 0,
        env,
        eventIdempotencyKey: channel.eventIdempotencyKey,
        expiresAt: "2026-07-30T06:00:00.000Z",
        fulfillmentIdempotencyPrefix: `generic-${channel.code}`,
        locale: "en",
        nowIso: NOW,
        orderId,
        orderPublicId: `order-public-${channel.code}`,
        orderTokenHash: BUYER_BINDING_HASH,
        reservationToken: `reservation-${channel.code}`,
        lines: [{
          fulfillmentType: "manual",
          priceMinor: 0,
          productId: PRODUCT_ID,
          productTitle: "Generic product",
          productVersion: 1,
          quantity: 1,
          sku: "GENERIC-A",
          title: "Default",
          variantId: VARIANT_ID,
          variantVersion: 1,
        }],
        shopId: SHOP_ID,
        subtotalMinor: 0,
        totalMinor: 0,
      });
      expect(result.fulfillmentStatus).toBe("fulfilled");
      expect(database.prepare("SELECT status FROM entitlements WHERE order_id = ?").get(orderId)).toEqual({ status: "active" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM order_item_entitlement_requirements WHERE order_id = ?").get(orderId)).toEqual({ count: 1 });
      expect(database.prepare("SELECT channel_code AS channelCode FROM order_channel_attributions WHERE order_id = ?").get(orderId)).toEqual({ channelCode: channel.attribution?.channelCode ?? channel.code });
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM entitlement_grants WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 3 });
  });

  it("expires active entitlements once and rejects generic/manual overlap", async () => {
    const { database } = createDatabase();
    seedBase(database);
    seedOrder(database, { id: "order-expiry-generic", itemId: "item-expiry-generic", paidAt: NOW, paymentStatus: "paid", status: "processing", totalMinor: 0 });
    database.exec(`
      INSERT INTO entitlements (
        id, shop_id, order_id, order_item_id, requirement_id, resource_id, buyer_binding_hash,
        status, grant_quantity, entitlement_ttl_seconds, access_expires_at, activated_at, version, created_at, updated_at
      ) VALUES ('ent-expiry-generic', '${SHOP_ID}', 'order-expiry-generic', 'item-expiry-generic', 'req-order-expiry-generic', '${RESOURCE_ID}', '${BUYER_BINDING_HASH}', 'active', 4, 3600, '2026-07-30T05:00:00.000Z', '${NOW}', 1, '${NOW}', '${NOW}');
      INSERT INTO entitlement_grants (
        id, shop_id, entitlement_id, requirement_id, order_id, resource_id, source_kind,
        source_payment_event_id, idempotency_key_hash, request_hash, request_id,
        granted_quantity, created_at
      ) VALUES ('grant-expiry-generic', '${SHOP_ID}', 'ent-expiry-generic', 'req-order-expiry-generic', 'order-expiry-generic', '${RESOURCE_ID}', 'free_checkout', NULL, '${HASH_C}', '${HASH_D}', 'request-expiry-generic', 4, '${NOW}');
      INSERT INTO entitlement_transitions (
        id, shop_id, entitlement_id, requirement_id, resource_id, entitlement_version,
        from_status, to_status, source_grant_id, reason_code, idempotency_key_hash, request_hash,
        actor_kind, actor_user_id, occurred_at, created_at
      ) VALUES ('transition-expiry-initial', '${SHOP_ID}', 'ent-expiry-generic', 'req-order-expiry-generic', '${RESOURCE_ID}', 1, NULL, 'active', 'grant-expiry-generic', 'seed_active', '${BUYER_BINDING_HASH}', '${HASH_B}', 'system', NULL, '${NOW}', '${NOW}');
      INSERT INTO fulfillments (id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at)
      VALUES ('fulfillment-expiry-generic', '${SHOP_ID}', 'order-expiry-generic', 'manual', 'pending', 'fulfillment-expiry-generic', '${NOW}');
    `);
    const result = await expireGenericEntitlements({ env: bindings(database), nowIso: "2026-07-30T05:01:00.000Z", shopId: SHOP_ID });
    expect(result).toBe(1);
    expect(database.prepare("SELECT status, version FROM entitlements WHERE id = 'ent-expiry-generic'").get()).toEqual({ status: "expired", version: 2 });
    expect(await expireGenericEntitlements({ env: bindings(database), nowIso: "2026-07-30T05:01:00.000Z", shopId: SHOP_ID })).toBe(0);
    expect(() => database.prepare(`INSERT INTO manual_fulfillment_executions (
      id, shop_id, order_id, order_item_id, fulfillment_id, execution_type, state,
      completed_quantity, actor_user_id, idempotency_key_hash, request_hash, request_id,
      completed_at, created_at
    ) VALUES ('execution-overlap', '${SHOP_ID}', 'order-expiry-generic', 'item-expiry-generic', 'fulfillment-expiry-generic', 'seller_attested_delivery', 'completed', 2, 'user-generic-a', '${BUYER_BINDING_HASH}', '${HASH_B}', 'request-overlap', '${NOW}', '${NOW}')`).run()).toThrow();
  });
});
