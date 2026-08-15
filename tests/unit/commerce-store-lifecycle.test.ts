import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { hmacToken } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";
import {
  checkoutCart,
  createCart,
  expireUnpaidOrders,
  getOrder,
  quoteCart,
} from "../../src/lib/commerce/store";
import { createQuoteEvidence, verifyQuoteEvidence } from "../../src/lib/commerce/quote-evidence";
import type { StorefrontShop } from "../../src/lib/storefront/store";
import { FALLBACK_STOREFRONT_TEMPLATE } from "../../src/lib/storefront/templates";

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

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
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

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
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
  const now = "2026-07-26T00:00:00.000Z";
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('commerce_lifecycle_user', 'commerce-lifecycle@example.test', 'Lifecycle test', 'active', '${now}', '${now}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (
      'shop_lifecycle', 'shop_public_lifecycle', 'lifecycle', 'Lifecycle',
      'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}'
    );
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (
      'product_lifecycle_manual', 'shop_lifecycle', 'manual-product', 'Manual product',
      '', 'active', 'manual', 1, '${now}', '${now}'
    );
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (
      'variant_lifecycle_manual', 'shop_lifecycle', 'product_lifecycle_manual',
      'LIFECYCLE-MANUAL', 'Default', '{}', 1000, 'VND', 1, 5, 'active', 1,
      '${now}', '${now}'
    );
  `);
  return new SqliteD1(database);
}

function shop(): StorefrontShop {
  return {
    access: "live",
    canonicalHostname: "lifecycle.selinow.com",
    content: {
      announcement: null,
      deliveryText: "Giao sau xác minh",
      description: "Description",
      footerText: "Footer",
      headline: "Headline",
      seoDescription: "Description",
      seoTitle: "Lifecycle",
      showExactStock: false,
      supportText: "Support",
      templateId: null,
    },
    currency: "VND",
    currentHostname: "lifecycle.selinow.com",
    defaultLocale: "vi",
    id: "shop_lifecycle",
    lowStockThreshold: 5,
    name: "Lifecycle",
    orderExpiryMinutes: 30,
    publicId: "shop_public_lifecycle",
    publicDetails: {
      deliveryText: "Giao sau xác minh",
      privacyUrl: null,
      refundPolicyUrl: null,
      support: { href: null, label: "Support" },
      termsUrl: null,
    },
    settingsVersion: 1,
    slug: "lifecycle",
    status: "active",
    currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    subscriptionState: "active",
    template: FALLBACK_STOREFRONT_TEMPLATE,
    theme: {
      accent: "#7C3AED",
      accentInk: "#FFFFFF",
      brand: "#5B5CEB",
      brandInk: "#FFFFFF",
      logoUrl: null,
    },
  };
}

function envFor(database: SqliteD1): AppBindings {
  return {
    IDENTIFIER_HMAC_SECRET: "commerce-lifecycle-secret",
    PLATFORM_DB: database as unknown as D1Database,
  } as AppBindings;
}

type ExpectedItem = { quantity: number; unitPriceMinor: number; variantId: string; variantVersion: number };

function expectedItems(items: unknown[]): ExpectedItem[] {
  return items.map((item) => item as ExpectedItem);
}

describe("commerce store lifecycle guards", () => {
  it("denies cross-tenant variant, cart, and order access at the D1 store boundary", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const otherShop: StorefrontShop = {
      ...currentShop,
      canonicalHostname: "other-lifecycle.selinow.com",
      currentHostname: "other-lifecycle.selinow.com",
      id: "shop_lifecycle_other",
      name: "Other lifecycle",
      publicId: "shop_public_lifecycle_other",
      slug: "other-lifecycle",
    };
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES (
        'shop_lifecycle_other', 'shop_public_lifecycle_other', 'other-lifecycle',
        'Other lifecycle', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1,
        '${now}', '${now}'
      );
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_lifecycle_other', 'shop_lifecycle_other', 'other-product',
        'Other product', '', 'active', 'manual', 1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_lifecycle_other', 'shop_lifecycle_other', 'product_lifecycle_other',
        'LIFECYCLE-OTHER', 'Default', '{}', 1000, 'VND', 1, 5, 'active', 1,
        '${now}', '${now}'
      );
    `);

    await expect(createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_other" }],
      locale: "vi",
      shop: currentShop,
    })).rejects.toMatchObject({ code: "catalog_changed", status: 409 });

    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_manual" }],
      locale: "vi",
      shop: currentShop,
    });
    await expect(quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: otherShop,
    })).rejects.toMatchObject({ code: "cart_not_found", status: 404 });

    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });
    const order = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected: expectedItems(quote.items),
      idempotencyKey: "checkout-tenant-denial-0001",
      shop: currentShop,
    });
    await expect(getOrder({
      env,
      orderPublicId: order.orderId,
      orderToken: order.orderToken,
      shop: otherShop,
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });

    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM carts WHERE shop_id = ?",
    ).get(otherShop.id)).toEqual({ count: 0 });
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?",
    ).get(otherShop.id)).toEqual({ count: 0 });
  });

  it("rejects website access to same-shop Telegram carts and orders", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const cartToken = "website-shaped-token-for-telegram-cart";
    const orderToken = "website-shaped-token-for-telegram-order";
    const [cartSubjectHash, orderTokenHash] = await Promise.all([
      hmacToken(env.IDENTIFIER_HMAC_SECRET, `cart:${currentShop.id}`, cartToken),
      hmacToken(env.IDENTIFIER_HMAC_SECRET, "order-access", orderToken),
    ]);
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      INSERT INTO carts (
        id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at
      ) VALUES (
        'cart_lifecycle_telegram', 'shop_lifecycle', 'telegram', '${cartSubjectHash}', 'vi',
        'active', '2099-07-26T00:00:00.000Z', '${now}', '${now}'
      );
      INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (
        'cart_lifecycle_telegram', 'shop_lifecycle', 'variant_lifecycle_manual', 1
      );
      INSERT INTO orders (
        id, public_id, shop_id, customer_id, order_number, source_channel, status,
        payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
        currency, locale, customer_email_masked, checkout_subject_hash,
        checkout_request_hash, checkout_cart_id, order_token_hash, expires_at,
        paid_at, fulfilled_at, created_at, updated_at
      ) VALUES (
        'order_lifecycle_telegram', 'order_public_lifecycle_telegram', 'shop_lifecycle',
        NULL, 'TG-ORDER-1', 'telegram', 'pending_payment', 'unpaid', 'reserved',
        1000, 0, 1000, 'VND', 'vi', NULL, 'telegram-checkout-subject',
        'telegram-checkout-request', 'cart_lifecycle_telegram', '${orderTokenHash}',
        '2099-07-26T00:00:00.000Z', NULL, NULL, '${now}', '${now}'
      );
    `);

    await expect(quoteCart({
      cartId: "cart_lifecycle_telegram",
      cartToken,
      env,
      shop: currentShop,
    })).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
    await expect(getOrder({
      env,
      orderPublicId: "order_public_lifecycle_telegram",
      orderToken,
      shop: currentShop,
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("rejects quote and checkout for an expired cart before creating an order or reservation", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_lifecycle_expired', 'shop_lifecycle', 'expired-product',
        'Expired cart product', '', 'active', 'license_key', 1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_lifecycle_expired', 'shop_lifecycle', 'product_lifecycle_expired',
        'LIFECYCLE-EXPIRED', 'Default', '{}', 3000, 'VND', 1, 5, 'active', 1,
        '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, total_count, accepted_count,
        rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_lifecycle_expired', 'shop_lifecycle', 'variant_lifecycle_expired',
        'paste', 1, 1, 0, 'commerce_lifecycle_user', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'key_lifecycle_expired', 'shop_lifecycle', 'variant_lifecycle_expired',
        'batch_lifecycle_expired', 'available', 'ciphertext', 'iv', 'v1',
        'fingerprint-lifecycle-expired', '${now}'
      );
    `);
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_expired" }],
      locale: "vi",
      shop: currentShop,
    });
    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });
    database.database.prepare(
      "UPDATE carts SET expires_at = ? WHERE id = ? AND shop_id = ?",
    ).run("2026-07-25T23:59:59.000Z", cart.cartId, currentShop.id);

    await expect(quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    })).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected: expectedItems(quote.items),
      idempotencyKey: "checkout-expired-cart-0001",
      shop: currentShop,
    })).rejects.toMatchObject({ code: "cart_not_found", status: 404 });

    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?",
    ).get(currentShop.id)).toEqual({ count: 0 });
    expect(database.database.prepare(`
      SELECT status, reservation_token AS reservationToken,
        reserved_order_item_id AS reservedOrderItemId, reserved_until AS reservedUntil
      FROM inventory_keys WHERE id = ? AND shop_id = ?
    `).get("key_lifecycle_expired", currentShop.id)).toEqual({
      reservationToken: null,
      reservedOrderItemId: null,
      reservedUntil: null,
      status: "available",
    });
  });

  it("rejects checkout when a quoted variant changes price or version", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_manual" }],
      locale: "vi",
      shop: currentShop,
    });
    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });

    database.database.prepare(
      "UPDATE product_variants SET price_minor = ?, version = ? WHERE id = ? AND shop_id = ?",
    ).run(1500, 2, "variant_lifecycle_manual", currentShop.id);

    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected: expectedItems(quote.items),
      idempotencyKey: "checkout-stale-quote-0001",
      shop: currentShop,
    })).rejects.toMatchObject({ code: "checkout_changed", status: 409 });
    expect(database.database.prepare(
      "SELECT state FROM carts WHERE id = ? AND shop_id = ?",
    ).get(cart.cartId, currentShop.id)).toEqual({ state: "active" });
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ? AND checkout_subject_hash IS NOT NULL",
    ).get(currentShop.id)).toEqual({ count: 0 });
  });

  it("rejects expired, tampered, and mismatched quote evidence while the catalog is unchanged", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_manual" }],
      locale: "vi",
      shop: currentShop,
    });
    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });
    const expected = expectedItems(quote.items);
    const expiredAt = new Date(Date.now() - 1_000);
    const quoteEvidence = await createQuoteEvidence({
      cartId: cart.cartId,
      expected,
      expiresAt: expiredAt.toISOString(),
      issuedAt: new Date(expiredAt.getTime() - 5 * 60_000).toISOString(),
      secret: env.IDENTIFIER_HMAC_SECRET,
      shopId: currentShop.id,
    });

    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected,
      idempotencyKey: "checkout-expired-quote-0001",
      quoteEvidence,
      shop: currentShop,
    })).rejects.toMatchObject({ code: "quote_expired", status: 409 });
    const tamperedQuoteEvidence = `${quote.quoteEvidence.slice(0, -1)}${quote.quoteEvidence.endsWith("a") ? "b" : "a"}`;
    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected,
      idempotencyKey: "checkout-tampered-quote-0001",
      quoteEvidence: tamperedQuoteEvidence,
      shop: currentShop,
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    const mismatchedQuoteEvidence = await createQuoteEvidence({
      cartId: "cart_other",
      expected,
      expiresAt: quote.expiresAt,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      secret: env.IDENTIFIER_HMAC_SECRET,
      shopId: currentShop.id,
    });
    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected,
      idempotencyKey: "checkout-mismatched-quote-0001",
      quoteEvidence: mismatchedQuoteEvidence,
      shop: currentShop,
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    expect(database.database.prepare(
      "SELECT state FROM carts WHERE id = ? AND shop_id = ?",
    ).get(cart.cartId, currentShop.id)).toEqual({ state: "active" });
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?",
    ).get(currentShop.id)).toEqual({ count: 0 });
  });

  it("caps a quote at a cart that is close to expiry", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_manual" }],
      locale: "vi",
      shop: currentShop,
    });
    const cartExpiresAt = new Date(Date.now() + 30_000).toISOString();
    database.database.prepare(
      "UPDATE carts SET expires_at = ? WHERE id = ? AND shop_id = ?",
    ).run(cartExpiresAt, cart.cartId, currentShop.id);

    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });

    expect(quote.expiresAt).toBe(cartExpiresAt);
    await expect(verifyQuoteEvidence({
      cartId: cart.cartId,
      cartExpiresAt,
      evidence: quote.quoteEvidence,
      expected: expectedItems(quote.items),
      now: new Date(Date.parse(cartExpiresAt) - 1),
      secret: env.IDENTIFIER_HMAC_SECRET,
      shopId: currentShop.id,
    })).resolves.toBeUndefined();
  });

  it("replays an identical website checkout and rejects a changed payload", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_manual" }],
      locale: "vi",
      shop: currentShop,
    });
    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });
    const input = {
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env,
      expected: expectedItems(quote.items),
      idempotencyKey: "checkout-website-replay-0001",
      quoteEvidence: quote.quoteEvidence,
      shop: currentShop,
    };
    const first = await checkoutCart(input);
    await expect(checkoutCart(input)).resolves.toEqual(first);

    const orderRow = database.database.prepare(`
      SELECT id, customer_id AS customerId, order_token_hash AS tokenHash
      FROM orders WHERE shop_id = ? AND public_id = ?
    `).get(currentShop.id, first.orderId) as {
      customerId: string;
      id: string;
      tokenHash: string;
    };
    let previousHash = orderRow.tokenHash;
    let latestToken = first.orderToken;
    let firstRecoveredToken = "";
    for (let generation = 1; generation <= 2; generation += 1) {
      const recoveryId = `orc_checkout_replay_${String(generation)}`;
      const issuedAt = `2026-07-26T00:0${String(generation)}:00.000Z`;
      const expiresAt = `2026-07-26T00:${String(15 + generation).padStart(2, "0")}:00.000Z`;
      const retentionExpiresAt = `2026-08-26T00:0${String(generation)}:00.000Z`;
      latestToken = await hmacToken(
        env.IDENTIFIER_HMAC_SECRET,
        `buyer-order-recovery-access-token:v1:${currentShop.id}`,
        recoveryId,
      );
      if (generation === 1) firstRecoveredToken = latestToken;
      const replacementHash = await hmacToken(env.IDENTIFIER_HMAC_SECRET, "order-access", latestToken);
      database.database.prepare(`
        INSERT INTO order_access_recovery_tokens (
          id, shop_id, order_id, customer_id, token_hash, recipient_hash,
          issued_request_id, issued_at, expires_at, retention_expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recoveryId,
        currentShop.id,
        orderRow.id,
        orderRow.customerId,
        String(generation).repeat(64),
        String(generation + 2).repeat(64),
        `request-checkout-recovery-${String(generation)}`,
        issuedAt,
        expiresAt,
        retentionExpiresAt,
        issuedAt,
      );
      database.database.prepare(`
        UPDATE order_access_recovery_tokens
        SET consumed_at = ?, consumed_request_id = ?, previous_order_token_hash = ?,
          replacement_order_token_hash = ?
        WHERE id = ? AND shop_id = ?
      `).run(
        `2026-07-26T00:0${String(generation)}:01.000Z`,
        `request-checkout-consume-${String(generation)}`,
        previousHash,
        replacementHash,
        recoveryId,
        currentShop.id,
      );
      previousHash = replacementHash;
    }

    const recoveredReplay = await checkoutCart(input);
    expect(recoveredReplay).toEqual({ ...first, orderToken: latestToken });
    await expect(getOrder({ env, orderPublicId: first.orderId, orderToken: first.orderToken, shop: currentShop }))
      .rejects.toMatchObject({ code: "order_not_found", status: 404 });
    await expect(getOrder({ env, orderPublicId: first.orderId, orderToken: firstRecoveredToken, shop: currentShop }))
      .rejects.toMatchObject({ code: "order_not_found", status: 404 });
    await expect(getOrder({ env, orderPublicId: first.orderId, orderToken: latestToken, shop: currentShop }))
      .resolves.toMatchObject({ orderId: first.orderId });
    const refreshedEvidence = await createQuoteEvidence({
      cartId: cart.cartId,
      expected: input.expected,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      issuedAt: new Date().toISOString(),
      secret: env.IDENTIFIER_HMAC_SECRET,
      shopId: currentShop.id,
    });
    await expect(checkoutCart({ ...input, quoteEvidence: refreshedEvidence })).resolves.toEqual(recoveredReplay);
    await expect(checkoutCart({ ...input, cartToken: "invalid-cart-token-for-replay" })).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
    await expect(checkoutCart({
      cartId: input.cartId,
      cartToken: input.cartToken,
      customerEmail: input.customerEmail,
      env: input.env,
      expected: input.expected,
      idempotencyKey: input.idempotencyKey,
      shop: input.shop,
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    const expiredEvidence = await createQuoteEvidence({
      cartId: cart.cartId,
      expected: input.expected,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      issuedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      secret: env.IDENTIFIER_HMAC_SECRET,
      shopId: currentShop.id,
    });
    await expect(checkoutCart({ ...input, quoteEvidence: expiredEvidence })).rejects.toMatchObject({ code: "quote_expired", status: 409 });
    await expect(checkoutCart({ ...input, customerEmail: "other@example.test" })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ? AND checkout_subject_hash IS NOT NULL",
    ).get(currentShop.id)).toEqual({ count: 1 });
    expect(database.database.prepare(
      "SELECT state FROM carts WHERE id = ? AND shop_id = ?",
    ).get(cart.cartId, currentShop.id)).toEqual({ state: "converted" });
  });

  it("fails closed on drifted website replay attribution while preserving legacy null attribution", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_manual" }],
      locale: "vi",
      shop: currentShop,
    });
    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });
    const input = {
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected: expectedItems(quote.items),
      idempotencyKey: "checkout-website-attribution-replay-0001",
      quoteEvidence: quote.quoteEvidence,
      shop: currentShop,
    };
    const first = await checkoutCart(input);
    database.database.prepare(
      "UPDATE orders SET source_channel = 'telegram' WHERE shop_id = ? AND public_id = ?",
    ).run(currentShop.id, first.orderId);
    await expect(checkoutCart(input)).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    database.database.prepare(
      "UPDATE orders SET source_channel = 'web' WHERE shop_id = ? AND public_id = ?",
    ).run(currentShop.id, first.orderId);

    database.database.prepare(`
      UPDATE order_channel_attributions
      SET channel_code = 'telegram'
      WHERE shop_id = ? AND order_id = (
        SELECT id FROM orders WHERE shop_id = ? AND public_id = ?
      )
    `).run(currentShop.id, currentShop.id, first.orderId);
    await expect(checkoutCart(input)).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

    database.database.prepare(`
      DELETE FROM order_channel_attributions
      WHERE shop_id = ? AND order_id = (
        SELECT id FROM orders WHERE shop_id = ? AND public_id = ?
      )
    `).run(currentShop.id, currentShop.id, first.orderId);
    database.database.prepare(
      "UPDATE orders SET order_token_hash = 'tampered-token-hash' WHERE shop_id = ? AND public_id = ?",
    ).run(currentShop.id, first.orderId);
    await expect(checkoutCart(input)).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    const restoredTokenHash = await hmacToken(env.IDENTIFIER_HMAC_SECRET, "order-access", first.orderToken);
    database.database.prepare(
      "UPDATE orders SET order_token_hash = ? WHERE shop_id = ? AND public_id = ?",
    ).run(restoredTokenHash, currentShop.id, first.orderId);
    await expect(checkoutCart(input)).resolves.toEqual(first);
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?",
    ).get(currentShop.id)).toEqual({ count: 1 });
  });

  it("records website free license fulfillment and fulfillment-item ledger rows", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_lifecycle_free', 'shop_lifecycle', 'free-product',
        'Free license product', '', 'active', 'license_key', 1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_lifecycle_free', 'shop_lifecycle', 'product_lifecycle_free',
        'LIFECYCLE-FREE', 'Default', '{}', 0, 'VND', 1, 5, 'active', 1,
        '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, total_count, accepted_count,
        rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_lifecycle_free', 'shop_lifecycle', 'variant_lifecycle_free',
        'paste', 1, 1, 0, 'commerce_lifecycle_user', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'key_lifecycle_free', 'shop_lifecycle', 'variant_lifecycle_free',
        'batch_lifecycle_free', 'available', 'ciphertext', 'iv', 'v1',
        'fingerprint-lifecycle-free', '${now}'
      );
    `);
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_free" }],
      locale: "vi",
      shop: currentShop,
    });
    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });
    const order = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected: expectedItems(quote.items),
      idempotencyKey: "checkout-free-fulfillment-0001",
      shop: currentShop,
    });

    expect(order).toMatchObject({
      fulfillmentStatus: "fulfilled",
      paymentStatus: "paid",
      status: "completed",
      totalMinor: 0,
    });
    const fulfillment = database.database.prepare(`
      SELECT fulfillments.id AS id, fulfillments.shop_id AS shopId,
        fulfillments.order_id AS orderId, fulfillment_type AS fulfillmentType,
        state, idempotency_key AS idempotencyKey
      FROM fulfillments
      INNER JOIN orders ON orders.id = fulfillments.order_id AND orders.shop_id = fulfillments.shop_id
      WHERE fulfillments.shop_id = ? AND orders.public_id = ?
    `).get(currentShop.id, order.orderId) as {
      fulfillmentType: string;
      id: string;
      idempotencyKey: string;
      orderId: string;
      shopId: string;
      state: string;
    } | undefined;
    if (fulfillment === undefined) throw new Error("website_free_fulfillment_missing");
    expect(fulfillment.fulfillmentType).toBe("digital_keys");
    expect(fulfillment.idempotencyKey).toBe(`website-free:${fulfillment.orderId}`);
    expect(typeof fulfillment.orderId).toBe("string");
    expect(fulfillment.shopId).toBe(currentShop.id);
    expect(fulfillment.state).toBe("fulfilled");
    const fulfillmentItem = database.database.prepare(`
      SELECT fulfillment_items.shop_id AS shopId,
        fulfillment_items.fulfillment_id AS fulfillmentId,
        fulfillment_items.order_item_id AS orderItemId,
        fulfillment_items.inventory_key_id AS inventoryKeyId,
        inventory_keys.status AS inventoryStatus,
        inventory_keys.sold_order_item_id AS soldOrderItemId
      FROM fulfillment_items
      INNER JOIN inventory_keys
        ON inventory_keys.id = fulfillment_items.inventory_key_id
        AND inventory_keys.shop_id = fulfillment_items.shop_id
      WHERE fulfillment_items.shop_id = ? AND fulfillment_items.fulfillment_id = ?
    `).get(currentShop.id, fulfillment.id) as {
      fulfillmentId: string;
      inventoryKeyId: string;
      inventoryStatus: string;
      orderItemId: string;
      shopId: string;
      soldOrderItemId: string;
    } | undefined;
    if (fulfillmentItem === undefined) throw new Error("website_free_fulfillment_item_missing");
    expect(fulfillmentItem.fulfillmentId).toBe(fulfillment.id);
    expect(fulfillmentItem.inventoryKeyId).toBe("key_lifecycle_free");
    expect(fulfillmentItem.inventoryStatus).toBe("sold");
    expect(fulfillmentItem.shopId).toBe(currentShop.id);
    expect(typeof fulfillmentItem.soldOrderItemId).toBe("string");
    expect(fulfillmentItem.soldOrderItemId).toBe(fulfillmentItem.orderItemId);
  });

  it("expires unpaid orders and releases only their reserved inventory", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_lifecycle_license', 'shop_lifecycle', 'license-product',
        'License product', '', 'active', 'license_key', 1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_lifecycle_license', 'shop_lifecycle', 'product_lifecycle_license',
        'LIFECYCLE-LICENSE', 'Default', '{}', 2500, 'VND', 1, 5, 'active', 1,
        '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, total_count, accepted_count,
        rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_lifecycle_license', 'shop_lifecycle', 'variant_lifecycle_license',
        'paste', 1, 1, 0, 'commerce_lifecycle_user', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'key_lifecycle_license', 'shop_lifecycle', 'variant_lifecycle_license',
        'batch_lifecycle_license', 'available', 'ciphertext', 'iv', 'v1',
        'fingerprint-lifecycle-license', '${now}'
      );
    `);
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_lifecycle_license" }],
      locale: "vi",
      shop: currentShop,
    });
    const quote = await quoteCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      env,
      shop: currentShop,
    });
    const order = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer-lifecycle@example.test",
      env,
      expected: expectedItems(quote.items),
      idempotencyKey: "checkout-expiry-release-0001",
      shop: currentShop,
    });

    expect(order).toMatchObject({ paymentStatus: "unpaid", status: "pending_payment" });
    const reservedKey = database.database.prepare(
      "SELECT status, reservation_token, reserved_order_item_id FROM inventory_keys WHERE id = ? AND shop_id = ?",
    ).get("key_lifecycle_license", currentShop.id) as {
      reserved_order_item_id: string | null;
      reservation_token: string | null;
      status: string;
    };
    expect(reservedKey.status).toBe("reserved");
    expect(typeof reservedKey.reservation_token).toBe("string");
    expect(typeof reservedKey.reserved_order_item_id).toBe("string");

    const expiredAt = new Date(new Date(order.expiresAt).getTime() + 1_000).toISOString();
    await expect(expireUnpaidOrders(env, expiredAt)).resolves.toBe(1);
    expect(database.database.prepare(
      "SELECT status, payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus FROM orders WHERE public_id = ? AND shop_id = ?",
    ).get(order.orderId, currentShop.id)).toEqual({
      fulfillmentStatus: "unfulfilled",
      paymentStatus: "expired",
      status: "expired",
    });
    expect(database.database.prepare(
      "SELECT status, reservation_token, reserved_order_item_id, reserved_until FROM inventory_keys WHERE id = ? AND shop_id = ?",
    ).get("key_lifecycle_license", currentShop.id)).toEqual({
      reserved_order_item_id: null,
      reserved_until: null,
      reservation_token: null,
      status: "available",
    });
  });

  it("reconciles expired orphan reservations without touching future reservations", async () => {
    const database = createDatabase();
    const env = envFor(database);
    const currentShop = shop();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_lifecycle_orphan', 'shop_lifecycle', 'orphan-product',
        'Orphan product', '', 'active', 'license_key', 1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_lifecycle_orphan', 'shop_lifecycle', 'product_lifecycle_orphan',
        'LIFECYCLE-ORPHAN', 'Default', '{}', 1000, 'VND', 1, 5, 'active', 1,
        '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, total_count, accepted_count,
        rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_lifecycle_orphan', 'shop_lifecycle', 'variant_lifecycle_orphan',
        'paste', 2, 2, 0, 'commerce_lifecycle_user', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, reservation_token,
        reserved_order_item_id, reserved_until, created_at
      ) VALUES
        ('key_lifecycle_orphan_expired', 'shop_lifecycle', 'variant_lifecycle_orphan',
          'batch_lifecycle_orphan', 'reserved', 'ciphertext', 'iv', 'v1',
          'fingerprint-orphan-expired', 'reservation-orphan-expired',
          'missing-order-item', '2026-07-25T23:59:59.000Z', '${now}'),
        ('key_lifecycle_orphan_future', 'shop_lifecycle', 'variant_lifecycle_orphan',
          'batch_lifecycle_orphan', 'reserved', 'ciphertext', 'iv', 'v1',
          'fingerprint-orphan-future', 'reservation-orphan-future',
          'missing-order-item-future', '2026-07-27T00:00:00.000Z', '${now}');
    `);

    await expect(expireUnpaidOrders(env, now)).resolves.toBe(0);
    expect(database.database.prepare(`
      SELECT status, reservation_token AS reservationToken,
        reserved_order_item_id AS reservedOrderItemId, reserved_until AS reservedUntil
      FROM inventory_keys WHERE id = ? AND shop_id = ?
    `).get("key_lifecycle_orphan_expired", currentShop.id)).toEqual({
      reservationToken: null,
      reservedOrderItemId: null,
      reservedUntil: null,
      status: "available",
    });
    expect(database.database.prepare(`
      SELECT status, reservation_token AS reservationToken,
        reserved_order_item_id AS reservedOrderItemId, reserved_until AS reservedUntil
      FROM inventory_keys WHERE id = ? AND shop_id = ?
    `).get("key_lifecycle_orphan_future", currentShop.id)).toEqual({
      reservationToken: "reservation-orphan-future",
      reservedOrderItemId: "missing-order-item-future",
      reservedUntil: "2026-07-27T00:00:00.000Z",
      status: "reserved",
    });
  });
});
