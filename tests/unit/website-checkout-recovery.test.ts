import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { hmacToken } from "../../src/lib/core/crypto";
import { createQuoteEvidence } from "../../src/lib/commerce/quote-evidence";
import {
  prepareWebsiteCheckoutRecovery,
  recoverWebsiteCheckout,
} from "../../src/lib/commerce/website-checkout-recovery";
import { websiteCheckoutFingerprint } from "../../src/lib/commerce/store";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

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
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  const now = "2026-07-29T00:00:00.000Z";
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('recovery-user', 'recovery@example.test', 'Recovery User', 'active', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop_recovery', 'shop_public_recovery', 'recovery', 'Recovery', 'active', 'en', 'VND', 'UTC', 1, '${now}', '${now}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES ('product_recovery', 'shop_recovery', 'recovery-product', 'Recovery product', '', 'active', 'manual', 1, '${now}', '${now}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES ('var_22222222-2222-4222-8222-222222222222', 'shop_recovery', 'product_recovery', 'RECOVERY-SKU', 'Default', '{}', 9000, 'VND', 1, 5, 'active', 3, '${now}', '${now}');
    INSERT INTO discounts (id, shop_id, code_normalized, type, value, currency, minimum_minor, status, created_at, updated_at)
    VALUES ('discount_recovery', 'shop_recovery', 'WELCOME10', 'percentage', 1000, 'VND', 0, 'active', '${now}', '${now}');
  `);
  return new SqliteD1(database);
}

function shop(): StorefrontShop {
  return {
    currency: "VND",
    defaultLocale: "en",
    id: "shop_recovery",
    status: "active",
    subscriptionState: "active",
  } as StorefrontShop;
}

function envFor(database: SqliteD1): AppBindings {
  return {
    IDENTIFIER_HMAC_SECRET: "website-checkout-recovery-secret",
    PLATFORM_DB: database as unknown as D1Database,
  } as AppBindings;
}

const cartId = "cart_11111111-1111-4111-8111-111111111111";
const cartToken = "cart-token-recovery-12345678901234567890";
const expected = [{ quantity: 1, unitPriceMinor: 9_000, variantId: "var_22222222-2222-4222-8222-222222222222", variantVersion: 3 }];
const testNow = Date.now();
const quoteIssuedAt = new Date(testNow).toISOString();
const cartExpiresAt = new Date(testNow + 24 * 60 * 60_000).toISOString();
const quoteExpiresAt = new Date(testNow + 4 * 60_000).toISOString();

async function seedCart(database: SqliteD1, channel: "telegram" | "web" = "web", discountCode: string | null = null): Promise<void> {
  const subjectHash = await hmacToken("website-checkout-recovery-secret", "cart:shop_recovery", cartToken);
  await database.prepare("INSERT INTO carts (id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'en', 'active', ?, ?, ?)").bind(cartId, "shop_recovery", channel, subjectHash, cartExpiresAt, quoteIssuedAt, quoteIssuedAt).run();
  if (discountCode !== null) await database.prepare("UPDATE carts SET discount_code_normalized = ? WHERE id = ? AND shop_id = ?").bind(discountCode, cartId, "shop_recovery").run();
  if (channel === "web") {
    await database.prepare("INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (?, ?, ?, ?)").bind(cartId, "shop_recovery", expected[0]?.variantId, expected[0]?.quantity).run();
  }
}

async function seedOrder(database: SqliteD1, input: { checkoutCartId?: string; discountMinor?: number; requestHash: string; subjectHash: string; tokenHash: string; totalMinor?: number }): Promise<void> {
  await database.prepare(`INSERT INTO orders (
    id, public_id, shop_id, customer_id, order_number, source_channel, status,
    payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
    currency, locale, customer_email_masked, checkout_subject_hash, checkout_request_hash,
    checkout_cart_id, order_token_hash, expires_at, paid_at, fulfilled_at, created_at, updated_at
  ) VALUES (?, ?, ?, NULL, ?, 'web', 'pending_payment', 'unpaid', 'reserved', 9000, ?, ?, 'VND', 'en', NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`) 
    .bind("order_recovery", "order_33333333-3333-4333-8333-333333333333", "shop_recovery", "SO-RECOVERY-1", input.discountMinor ?? 0, input.totalMinor ?? 9000, input.subjectHash, input.requestHash, input.checkoutCartId ?? cartId, input.tokenHash, quoteExpiresAt, quoteIssuedAt, quoteIssuedAt)
    .run();
}

async function createQuote(secret: string, input: { discountCode?: string | null; discountMinor?: number; totalMinor?: number } = {}): Promise<string> {
  const expectedItem = expected[0];
  if (expectedItem === undefined) throw new Error("recovery_expected_item_missing");
  return createQuoteEvidence({
    catalog: [{ productVersion: 1, ...expectedItem }],
    cartId,
    cartExpiresAt,
    expected,
    expiresAt: quoteExpiresAt,
    issuedAt: quoteIssuedAt,
    pricing: { discountCode: input.discountCode ?? null, discountMinor: input.discountMinor ?? 0, totalMinor: input.totalMinor ?? 9_000 },
    secret,
    shopId: "shop_recovery",
  });
}

describe("website checkout recovery", () => {
  it("mints recovery evidence only after a currently valid quote", async () => {
    const database = createDatabase();
    await seedCart(database);
    const env = envFor(database);
    const quoteEvidence = await createQuote(env.IDENTIFIER_HMAC_SECRET);

    const recovery = await prepareWebsiteCheckoutRecovery({
      cartId,
      cartToken,
      customerEmail: "buyer@example.com",
      env,
      expected,
      idempotencyKey: "checkout-recovery-intent-0001",
      quoteEvidence,
      shop: shop(),
    });

    expect(recovery.expiresAt).toBe(cartExpiresAt);
    await expect(recoverWebsiteCheckout({
      cartId,
      cartToken,
      customerEmail: "buyer@example.com",
      env,
      expected,
      idempotencyKey: "checkout-recovery-intent-0001",
      recoveryEvidence: recovery.evidence,
      shop: shop(),
    })).rejects.toMatchObject({ code: "checkout_not_found", status: 404 });
  });

  it("returns only an existing exact-match order and derives an authorized token", async () => {
    const database = createDatabase();
    await seedCart(database);
    const env = envFor(database);
    const idempotencyKey = "checkout-recovery-existing-0001";
    const quoteEvidence = await createQuote(env.IDENTIFIER_HMAC_SECRET);
    const recovery = await prepareWebsiteCheckoutRecovery({ cartId, cartToken, customerEmail: null, env, expected, idempotencyKey, quoteEvidence, shop: shop() });
    const checkoutSubjectHash = await hmacToken(env.IDENTIFIER_HMAC_SECRET, "checkout:shop_recovery", idempotencyKey);
    const requestHash = await websiteCheckoutFingerprint({ cartId, customerEmail: null, discountCode: null, discountMinor: 0, expected, totalMinor: 9000 });
    const orderToken = await hmacToken(env.IDENTIFIER_HMAC_SECRET, "order-access-token:shop_recovery", idempotencyKey);
    const orderTokenHash = await hmacToken(env.IDENTIFIER_HMAC_SECRET, "order-access", orderToken);
    await seedOrder(database, { requestHash, subjectHash: checkoutSubjectHash, tokenHash: orderTokenHash });

    const attempts = await Promise.allSettled([
      recoverWebsiteCheckout({ cartId, cartToken, customerEmail: null, env, expected, idempotencyKey, recoveryEvidence: recovery.evidence, shop: shop() }),
      recoverWebsiteCheckout({ cartId, cartToken, customerEmail: null, env, expected, idempotencyKey, recoveryEvidence: recovery.evidence, shop: shop() }),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ value: { orderId: "order_33333333-3333-4333-8333-333333333333", orderToken, paymentStatus: "unpaid" } });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "checkout_recovery_consumed", status: 409 } });
    await expect(recoverWebsiteCheckout({ cartId, cartToken, customerEmail: null, env, expected, idempotencyKey, recoveryEvidence: recovery.evidence, shop: shop() })).rejects.toMatchObject({ code: "checkout_recovery_consumed", status: 409 });
    expect(database.database.prepare("SELECT consumed_order_id AS consumedOrderId FROM checkout_recovery_capabilities WHERE shop_id = ?").get("shop_recovery")).toEqual({ consumedOrderId: "order_recovery" });
  });

  it("fails closed on order request/cart conflicts and token-hash mismatch", async () => {
    const database = createDatabase();
    await seedCart(database);
    const env = envFor(database);
    const idempotencyKey = "checkout-recovery-conflict-0001";
    const quoteEvidence = await createQuote(env.IDENTIFIER_HMAC_SECRET);
    const recovery = await prepareWebsiteCheckoutRecovery({ cartId, cartToken, customerEmail: null, env, expected, idempotencyKey, quoteEvidence, shop: shop() });
    const checkoutSubjectHash = await hmacToken(env.IDENTIFIER_HMAC_SECRET, "checkout:shop_recovery", idempotencyKey);
    const requestHash = await websiteCheckoutFingerprint({ cartId, customerEmail: null, discountCode: null, discountMinor: 0, expected, totalMinor: 9000 });
    await seedOrder(database, { requestHash: "different-request-hash", subjectHash: checkoutSubjectHash, tokenHash: "wrong-token-hash" });

    await expect(recoverWebsiteCheckout({ cartId, cartToken, customerEmail: null, env, expected, idempotencyKey, recoveryEvidence: recovery.evidence, shop: shop() })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    database.database.prepare("UPDATE orders SET checkout_request_hash = ? WHERE public_id = ?").run(requestHash, "order_33333333-3333-4333-8333-333333333333");
    await expect(recoverWebsiteCheckout({ cartId, cartToken, customerEmail: null, env, expected, idempotencyKey, recoveryEvidence: recovery.evidence, shop: shop() })).rejects.toMatchObject({ code: "checkout_recovery_invalid", status: 409 });
  });

  it("does not mint evidence from an expired quote", async () => {
    const database = createDatabase();
    await seedCart(database);
    const env = envFor(database);
    const expired = await createQuoteEvidence({ cartId, cartExpiresAt, expected, expiresAt: new Date(testNow - 30_000).toISOString(), issuedAt: new Date(testNow - 5 * 60_000).toISOString(), secret: env.IDENTIFIER_HMAC_SECRET, shopId: "shop_recovery" });

    await expect(prepareWebsiteCheckoutRecovery({ cartId, cartToken, customerEmail: null, env, expected, idempotencyKey: "checkout-recovery-expired-0001", quoteEvidence: expired, shop: shop() })).rejects.toMatchObject({ code: "quote_expired", status: 409 });
  });

  it("does not mint recovery evidence from a quote without catalog and pricing claims", async () => {
    const database = createDatabase();
    await seedCart(database);
    const env = envFor(database);
    const legacyQuote = await createQuoteEvidence({
      cartId,
      cartExpiresAt,
      expected,
      expiresAt: quoteExpiresAt,
      issuedAt: quoteIssuedAt,
      secret: env.IDENTIFIER_HMAC_SECRET,
      shopId: "shop_recovery",
    });

    await expect(prepareWebsiteCheckoutRecovery({
      cartId,
      cartToken,
      customerEmail: null,
      env,
      expected,
      idempotencyKey: "checkout-recovery-legacy-0001",
      quoteEvidence: legacyQuote,
      shop: shop(),
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
  });

  it("does not accept a Telegram cart as website recovery proof", async () => {
    const database = createDatabase();
    await seedCart(database, "telegram");
    const env = envFor(database);
    const quoteEvidence = await createQuote(env.IDENTIFIER_HMAC_SECRET);

    await expect(prepareWebsiteCheckoutRecovery({
      cartId,
      cartToken,
      customerEmail: null,
      env,
      expected,
      idempotencyKey: "checkout-recovery-channel-0001",
      quoteEvidence,
      shop: shop(),
    })).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
  });
});
