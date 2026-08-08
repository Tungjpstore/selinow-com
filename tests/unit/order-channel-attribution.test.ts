import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareOrderChannelAttribution,
  resolveOrderChannelAttribution,
} from "../../src/lib/channels/attribution";
import {
  TELEGRAM_CHANNEL_CODE,
  WEBSITE_CHANNEL_CODE,
} from "../../src/lib/channels/builtins";
import { CommerceApplicationService } from "../../src/lib/commerce/application";
import { checkoutCart, createCart, quoteCart } from "../../src/lib/commerce/store";
import {
  createTelegramCheckoutApplication,
  createTelegramCheckoutApplicationKey,
  createTelegramCartMutationApplicationKey,
  persistTelegramQuoteAction,
  resolveTelegramCheckoutSnapshot,
  TelegramCartMutationPort,
} from "../../src/lib/commerce/telegram-port";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";
import {
  checkoutTelegramCart,
  type TelegramIdentity,
  type TelegramShop,
} from "../../src/lib/telegram/commerce";

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly afterAll: (sql: string, values: readonly SQLInputValue[], results: readonly Record<string, SQLInputValue>[]) => Promise<void> = () => Promise.resolve(),
  ) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  async all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    const results = this.database.prepare(this.sql).all(...this.values);
    await this.afterAll(this.sql, this.values, results);
    return { results };
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private variantReadGate: { reached: () => void; resume: Promise<void> } | null = null;
  private afterAllInterceptor: (sql: string, values: readonly SQLInputValue[], results: readonly Record<string, SQLInputValue>[]) => Promise<void> = () => Promise.resolve();

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, async (statementSql, values, results) => {
      const gate = this.variantReadGate;
      if (gate !== null && (statementSql.includes("FROM product_variants") || statementSql.includes("FROM cart_items"))) {
        this.variantReadGate = null;
        gate.reached();
        await gate.resume;
      }
      await this.afterAllInterceptor(statementSql, values, results);
    });
  }

  pauseNextVariantRead(): { reached: Promise<void>; resume: () => void } {
    let markReached: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { markReached = resolve; });
    const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
    this.variantReadGate = { reached: markReached, resume: resumePromise };
    return { reached, resume };
  }

  setAfterAllInterceptor(
    interceptor: (sql: string, values: readonly SQLInputValue[], results: readonly Record<string, SQLInputValue>[]) => Promise<void>,
  ): void {
    this.afterAllInterceptor = interceptor;
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
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop_attribution_a', 'shop_public_attribution_a', 'attribution-a', 'A',
        'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}'),
      ('shop_attribution_b', 'shop_public_attribution_b', 'attribution-b', 'B',
        'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, total_minor,
      currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, created_at, updated_at
    ) VALUES
      ('order_attribution_a', 'order_public_attribution_a', 'shop_attribution_a',
        '1001', 'web', 'pending_payment', 'unpaid', 'unfulfilled', 1000, 1000,
        'VND', 'vi', 'subject-a', 'token-a', '${now}', '${now}', '${now}'),
      ('order_attribution_b', 'order_public_attribution_b', 'shop_attribution_b',
        '1002', 'telegram', 'pending_payment', 'unpaid', 'unfulfilled', 1000, 1000,
        'VND', 'vi', 'subject-b', 'token-b', '${now}', '${now}', '${now}');
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (
      'product_attribution_web', 'shop_attribution_a', 'web-product', 'Web product',
      '', 'active', 'manual', 1, '${now}', '${now}'
    );
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (
      'variant_attribution_web', 'shop_attribution_a', 'product_attribution_web',
      'WEB-ATTR', 'Default', '{}', 1000, 'VND', 1, 5, 'active', 1, '${now}', '${now}'
    );
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (
      'product_attribution_web_free', 'shop_attribution_a', 'web-free-product',
      'Web free product', '', 'active', 'manual', 1, '${now}', '${now}'
    );
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (
      'variant_attribution_web_free', 'shop_attribution_a',
      'product_attribution_web_free', 'WEB-FREE', 'Default', '{}', 0, 'VND', 1, 5,
      'active', 1, '${now}', '${now}'
    );
  `);
  return new SqliteD1(database);
}

function storefrontShop(): StorefrontShop {
  return {
    access: "live",
    canonicalHostname: "attribution-a.selinow.com",
    content: {
      announcement: null,
      deliveryText: "Giao sau xác minh",
      description: "Description",
      footerText: "Footer",
      headline: "Headline",
      seoDescription: "Description",
      seoTitle: "Attribution A — Cửa hàng sản phẩm số",
      showExactStock: false,
      supportText: "Support",
    },
    currency: "VND",
    currentHostname: "attribution-a.selinow.com",
    defaultLocale: "vi",
    id: "shop_attribution_a",
    lowStockThreshold: 5,
    name: "Attribution A",
    orderExpiryMinutes: 30,
    publicId: "shop_public_attribution_a",
    publicDetails: {
      deliveryText: "Giao sau xác minh",
      privacyUrl: null,
      refundPolicyUrl: null,
      support: { href: null, label: "Support" },
      termsUrl: null,
    },
    settingsVersion: 1,
    slug: "attribution-a",
    status: "active",
    subscriptionState: "active",
    theme: {
      accent: "#7C3AED",
      accentInk: "#FFFFFF",
      brand: "#5B5CEB",
      brandInk: "#FFFFFF",
      logoUrl: null,
    },
  };
}

function telegramShop(): TelegramShop {
  return {
    currency: "VND",
    defaultLocale: "vi",
    id: "shop_attribution_b",
    name: "Attribution B",
    orderExpiryMinutes: 30,
    origin: "https://attribution-b.selinow.com",
    status: "active",
    subscriptionState: "active",
  };
}

function seedTelegramCheckout(database: SqliteD1, input: { cartId: string; integrationId: string; productId: string; subjectHash: string; variantCurrency?: string; variantId: string; variantPrice: number }): void {
  const now = "2026-07-26T00:00:00.000Z";
  const variantCurrency = input.variantCurrency ?? "VND";
  database.database.exec(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (
      '${input.productId}', 'shop_attribution_b', '${input.productId}', 'Telegram product', '', 'active', 'manual',
      1, '${now}', '${now}'
    );
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (
      '${input.variantId}', 'shop_attribution_b', '${input.productId}', 'TELEGRAM-IDEMPOTENCY', 'Default', '{}', ${String(input.variantPrice)},
      '${variantCurrency}', 1, 5, 'active', 1, '${now}', '${now}'
    );
    INSERT INTO shop_customers (
      id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at
    ) VALUES (
      '${input.productId}-customer', 'shop_attribution_b', NULL, 'Telegram customer', 'vi', 'active', '${now}', '${now}'
    );
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status,
      created_at, updated_at
    ) VALUES (
      '${input.integrationId}', '${input.integrationId}-public', '${input.integrationId}-webhook', 'shop_attribution_b', 'active',
      'verified', '${now}', '${now}'
    );
    INSERT INTO carts (
      id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at
    ) VALUES (
      '${input.cartId}', 'shop_attribution_b', 'telegram', '${input.subjectHash}', 'vi', 'active',
      '2099-07-26T00:00:00.000Z', '${now}', '${now}'
    );
    INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (
      '${input.cartId}', 'shop_attribution_b', '${input.variantId}', 1
    );
  `);
}

async function seedTelegramQuote(input: {
  env: AppBindings;
  identity: TelegramIdentity;
  integrationId: string;
  shop: TelegramShop;
  cartId: string;
  updateId: number;
}): Promise<string> {
  const key = await createTelegramCartMutationApplicationKey(input.env, input.shop.id, input.integrationId, input.updateId);
  const context = {
    actor: { customerId: input.identity.customerId, kind: "customer" as const },
    channel: { code: TELEGRAM_CHANNEL_CODE, connectionId: null },
    locale: input.shop.defaultLocale,
    requestId: key,
    shopId: input.shop.id,
  };
  const application = new CommerceApplicationService(new TelegramCartMutationPort({
    connectionId: null,
    env: input.env,
    expectedIdempotencyKey: key,
    identity: { customerId: input.identity.customerId, subjectHash: input.identity.subjectHash },
    integrationId: input.integrationId,
    shop: input.shop,
    updateId: input.updateId,
  }));
  const quote = await application.quoteCart(context, { cart: { access: { kind: "principal" }, cartId: input.cartId } });
  const cart = await input.env.PLATFORM_DB.prepare("SELECT discount_code_normalized AS discountCode FROM carts WHERE id = ? AND shop_id = ? LIMIT 1").bind(input.cartId, input.shop.id).first<{ discountCode: string | null }>();
  await persistTelegramQuoteAction({
    cartId: input.cartId,
    discountCode: cart?.discountCode ?? null,
    env: input.env,
    identity: { customerId: input.identity.customerId, subjectHash: input.identity.subjectHash },
    integrationId: input.integrationId,
    quote,
    shop: input.shop,
    updateId: input.updateId,
  });
  if (quote.quoteEvidence === undefined) throw new Error("telegram_quote_evidence_missing");
  return quote.quoteEvidence;
}

describe("built-in channel attribution contract", () => {
  it("maps website and Telegram adapters to compatibility source channels", () => {
    expect(resolveOrderChannelAttribution(WEBSITE_CHANNEL_CODE)).toEqual({
      adapterVersion: 1,
      channelCode: WEBSITE_CHANNEL_CODE,
      legacySourceChannel: "web",
    });
    expect(resolveOrderChannelAttribution(TELEGRAM_CHANNEL_CODE)).toEqual({
      adapterVersion: 1,
      channelCode: TELEGRAM_CHANNEL_CODE,
      legacySourceChannel: "telegram",
    });
  });

  it("writes tenant-bound attribution atomically and rejects cross-tenant order references", async () => {
    const database = createDatabase();
    const d1 = database as unknown as D1Database;
    const now = "2026-07-26T00:00:00.000Z";

    await prepareOrderChannelAttribution({
      channelCode: WEBSITE_CHANNEL_CODE,
      createdAt: now,
      database: d1,
      orderId: "order_attribution_a",
      shopId: "shop_attribution_a",
    }).run();
    await prepareOrderChannelAttribution({
      channelCode: TELEGRAM_CHANNEL_CODE,
      createdAt: now,
      database: d1,
      orderId: "order_attribution_b",
      shopId: "shop_attribution_b",
    }).run();

    expect(database.database.prepare(`
      SELECT shop_id AS shopId, order_id AS orderId, channel_code AS channelCode,
        adapter_version AS adapterVersion, connection_id AS connectionId
      FROM order_channel_attributions
      ORDER BY shop_id
    `).all()).toEqual([
      {
        adapterVersion: 1,
        channelCode: "website",
        connectionId: null,
        orderId: "order_attribution_a",
        shopId: "shop_attribution_a",
      },
      {
        adapterVersion: 1,
        channelCode: "telegram",
        connectionId: null,
        orderId: "order_attribution_b",
        shopId: "shop_attribution_b",
      },
    ]);

    expect(() => {
      void prepareOrderChannelAttribution({
        channelCode: WEBSITE_CHANNEL_CODE,
        createdAt: now,
        database: d1,
        orderId: "order_attribution_a",
        shopId: "shop_attribution_b",
      }).run();
    }).toThrow();
  });

  it("keeps website checkout behavior while dual-writing normalized attribution", async () => {
    const database = createDatabase();
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const shop = storefrontShop();
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_attribution_web" }],
      locale: "vi",
      shop,
    });
    const quote = await quoteCart({ cartId: cart.cartId, cartToken: cart.cartToken, env, shop });
    expect(quote).toMatchObject({ currency: "VND", discountMinor: 0, subtotalMinor: 1000, totalMinor: 1000 });
    expect(quote.items).toEqual([expect.objectContaining({ lineTotalMinor: 1000, quantity: 1, unitPriceMinor: 1000, variantId: "variant_attribution_web" })]);
    const expected = quote.items as Array<{ quantity: number; unitPriceMinor: number; variantId: string; variantVersion: number }>;
    const order = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: null,
      env,
      expected,
      idempotencyKey: "checkout-attribution-web-0001",
      shop,
    });

    expect(order).toMatchObject({ currency: "VND", fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 1000 });
    expect(typeof order.orderNumber).toBe("string");
    expect(database.database.prepare(`
      SELECT orders.source_channel AS sourceChannel,
        order_channel_attributions.channel_code AS channelCode,
        order_channel_attributions.adapter_version AS adapterVersion
      FROM orders
      INNER JOIN order_channel_attributions
        ON order_channel_attributions.shop_id = orders.shop_id
        AND order_channel_attributions.order_id = orders.id
      WHERE orders.public_id = ?
    `).get(order.orderId)).toEqual({
      adapterVersion: 1,
      channelCode: "website",
      sourceChannel: "web",
    });
    const websiteEvent = database.database.prepare(`
      SELECT domain_events.event_type AS eventType,
        domain_events.idempotency_key_hash AS idempotencyHash,
        domain_events.source_connection_id AS sourceConnectionId,
        domain_events.status
      FROM domain_events
      INNER JOIN orders ON orders.id = domain_events.aggregate_id
      WHERE orders.public_id = ?
    `).get(order.orderId) as Record<string, unknown>;
    expect(websiteEvent).toMatchObject({
      eventType: "order.created",
      sourceConnectionId: null,
      status: "pending",
    });
    expect(String(websiteEvent.idempotencyHash)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("atomically prevents two idempotency keys from converting one website cart", async () => {
    const database = createDatabase();
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const shop = storefrontShop();
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_attribution_web" }],
      locale: "vi",
      shop,
    });
    const quote = await quoteCart({ cartId: cart.cartId, cartToken: cart.cartToken, env, shop });
    const expected = quote.items as Array<{ quantity: number; unitPriceMinor: number; variantId: string; variantVersion: number }>;
    const gate = database.pauseNextVariantRead();
    const staleCheckout = checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: null,
      env,
      expected,
      idempotencyKey: "checkout-cart-race-loser-0001",
      shop,
    });

    await gate.reached;
    const winner = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: null,
      env,
      expected,
      idempotencyKey: "checkout-cart-race-winner-0002",
      shop,
    });
    gate.resume();

    await expect(staleCheckout).rejects.toMatchObject({ code: "checkout_failed", status: 409 });
    expect(winner).toMatchObject({ paymentStatus: "unpaid", status: "pending_payment" });
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?",
    ).get(shop.id)).toEqual({ count: 2 });
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM order_channel_attributions WHERE shop_id = ?",
    ).get(shop.id)).toEqual({ count: 1 });
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM domain_events WHERE shop_id = ? AND event_type = 'order.created'",
    ).get(shop.id)).toEqual({ count: 1 });
    expect(database.database.prepare(
      "SELECT state FROM carts WHERE id = ? AND shop_id = ?",
    ).get(cart.cartId, shop.id)).toEqual({ state: "converted" });
  });

  it("rejects a paid non-VND website checkout before customer, order, or inventory reservation writes", async () => {
    const database = createDatabase();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      DELETE FROM product_variants
      WHERE shop_id = 'shop_attribution_a';
      UPDATE shops SET currency = 'USD' WHERE id = 'shop_attribution_a';
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_attribution_web', 'shop_attribution_a', 'product_attribution_web',
        'WEB-ATTR', 'Default', '{}', 1000, 'USD', 1, 5, 'active', 1, '${now}', '${now}'
      );
      UPDATE products SET fulfillment_type = 'license_key'
      WHERE id = 'product_attribution_web' AND shop_id = 'shop_attribution_a';
      INSERT INTO platform_users (
        id, email_normalized, display_name, status, created_at, updated_at
      ) VALUES (
        'user_non_vnd_web', 'non-vnd-web@example.test', 'Non VND Web',
        'active', '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, filename_sanitized,
        total_count, accepted_count, rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_non_vnd_web', 'shop_attribution_a', 'variant_attribution_web',
        'paste', NULL, 1, 1, 0, 'user_non_vnd_web', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'inventory_non_vnd_web', 'shop_attribution_a', 'variant_attribution_web',
        'batch_non_vnd_web', 'available', 'ciphertext', 'iv', 'v1',
        'fingerprint-non-vnd-web', '${now}'
      );
    `);
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const shop = { ...storefrontShop(), currency: "USD" };
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_attribution_web" }],
      locale: "en",
      shop,
    });
    const quote = await quoteCart({ cartId: cart.cartId, cartToken: cart.cartToken, env, shop });
    const orderCountBefore = database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(shop.id);

    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env,
      expected: quote.items,
      idempotencyKey: "checkout-non-vnd-web-0001",
      quoteEvidence: quote.quoteEvidence,
      shop,
    })).rejects.toMatchObject({
      code: "payment_currency_unsupported",
      issues: undefined,
      status: 409,
    });

    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(shop.id)).toEqual(orderCountBefore);
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM shop_customers WHERE shop_id = ? AND email_normalized = ?").get(shop.id, "buyer@example.test")).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT status, reservation_token AS reservationToken, reserved_order_item_id AS reservedOrderItemId FROM inventory_keys WHERE id = ? AND shop_id = ?").get("inventory_non_vnd_web", shop.id)).toEqual({ reservationToken: null, reservedOrderItemId: null, status: "available" });
    expect(database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(cart.cartId, shop.id)).toEqual({ state: "active" });
  });

  it("lets one concurrent website/Telegram checkout consume the last key without crossing tenants", async () => {
    const database = createDatabase();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      UPDATE products SET fulfillment_type = 'license_key'
      WHERE id = 'product_attribution_web' AND shop_id = 'shop_attribution_a';
      INSERT INTO platform_users (
        id, email_normalized, display_name, status, created_at, updated_at
      ) VALUES (
        'user_attribution_owner', 'owner-attribution@example.com', 'Attribution owner',
        'active', '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, filename_sanitized,
        total_count, accepted_count, rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_cross_channel_a', 'shop_attribution_a', 'variant_attribution_web',
        'paste', 'cross-channel-a.txt', 1, 1, 0, 'user_attribution_owner', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'inventory_cross_channel_a', 'shop_attribution_a', 'variant_attribution_web',
        'batch_cross_channel_a', 'available', 'Y2lwaGVydGV4dA==', 'aXY=',
        'v1', 'cross-channel-fingerprint-a', '${now}'
      );
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_cross_channel_b', 'shop_attribution_b', 'cross-channel-b',
        'Cross-channel B', '', 'active', 'license_key', 1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_cross_channel_b', 'shop_attribution_b', 'product_cross_channel_b',
        'CROSS-B', 'Default', '{}', 1000, 'VND', 1, 5, 'active', 1, '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, filename_sanitized,
        total_count, accepted_count, rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_cross_channel_b', 'shop_attribution_b', 'variant_cross_channel_b',
        'paste', 'cross-channel-b.txt', 1, 1, 0, 'user_attribution_owner', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'inventory_cross_channel_b', 'shop_attribution_b', 'variant_cross_channel_b',
        'batch_cross_channel_b', 'available', 'Y2lwaGVydGV4dA==', 'aXY=',
        'v1', 'cross-channel-fingerprint-b', '${now}'
      );
      INSERT INTO telegram_integrations (
        id, public_id, webhook_public_id, shop_id, status, webhook_status,
        created_at, updated_at
      ) VALUES (
        'integration_cross_channel', 'integration_public_cross_channel',
        'webhook_public_cross_channel', 'shop_attribution_a', 'active',
        'verified', '${now}', '${now}'
      );
      INSERT INTO shop_customers (
        id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at
      ) VALUES (
        'customer_cross_channel', 'shop_attribution_a', NULL, 'Cross-channel customer',
        'vi', 'active', '${now}', '${now}'
      );
      INSERT INTO carts (
        id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at
      ) VALUES (
        'cart_cross_channel_telegram', 'shop_attribution_a', 'telegram',
        'subject-cross-channel', 'vi', 'active', '2099-07-26T00:00:00.000Z', '${now}', '${now}'
      );
      INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (
        'cart_cross_channel_telegram', 'shop_attribution_a', 'variant_attribution_web', 1
      );
    `);
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const shop = storefrontShop();
    const telegramIdentity: TelegramIdentity = {
      chatId: "555000111",
      customerId: "customer_cross_channel",
      identityId: "identity_cross_channel",
      subjectHash: "subject-cross-channel",
    };
    const telegramShop: TelegramShop = {
      currency: shop.currency,
      defaultLocale: shop.defaultLocale,
      id: shop.id,
      name: shop.name,
      orderExpiryMinutes: shop.orderExpiryMinutes,
      origin: "https://attribution-a.selinow.com",
      status: shop.status,
      subscriptionState: shop.subscriptionState,
    };
    const websiteCart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_attribution_web" }],
      locale: "vi",
      shop,
    });
    const websiteQuote = await quoteCart({ cartId: websiteCart.cartId, cartToken: websiteCart.cartToken, env, shop });
    const expected = websiteQuote.items as Array<{ quantity: number; unitPriceMinor: number; variantId: string; variantVersion: number }>;
    await seedTelegramQuote({ cartId: "cart_cross_channel_telegram", env, identity: telegramIdentity, integrationId: "integration_cross_channel", shop: telegramShop, updateId: 7001 });
    const gate = database.pauseNextVariantRead();
    const websiteCheckout = checkoutCart({
      cartId: websiteCart.cartId,
      cartToken: websiteCart.cartToken,
      customerEmail: null,
      env,
      expected,
      idempotencyKey: "checkout-cross-channel-web-0001",
      shop,
    });

    await gate.reached;
    const telegramOrder = await checkoutTelegramCart({
      env,
      identity: telegramIdentity,
      integrationId: "integration_cross_channel",
      quoteUpdateId: 7001,
      shop: telegramShop,
      updateId: 7001,
    });
    gate.resume();

    await expect(websiteCheckout).rejects.toMatchObject({ code: "inventory_unavailable", status: 409 });
    expect(telegramOrder).toMatchObject({ paymentStatus: "unpaid", status: "pending_payment", totalMinor: 1000 });
    expect(database.database.prepare(`
      SELECT id, status, shop_id AS shopId FROM inventory_keys
      WHERE id IN ('inventory_cross_channel_a', 'inventory_cross_channel_b') ORDER BY id
    `).all()).toEqual([
      { id: "inventory_cross_channel_a", shopId: "shop_attribution_a", status: "reserved" },
      { id: "inventory_cross_channel_b", shopId: "shop_attribution_b", status: "available" },
    ]);
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?",
    ).get(shop.id)).toEqual({ count: 2 });
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM order_channel_attributions WHERE shop_id = ?",
    ).get(shop.id)).toEqual({ count: 1 });
    expect(database.database.prepare(
      "SELECT state FROM carts WHERE id = ? AND shop_id = ?",
    ).get(websiteCart.cartId, shop.id)).toEqual({ state: "active" });
    expect(database.database.prepare(
      "SELECT state FROM carts WHERE id = ? AND shop_id = ?",
    ).get("cart_cross_channel_telegram", shop.id)).toEqual({ state: "converted" });
  });

  it("emits order.created and order.paid atomically for a free website checkout", async () => {
    const database = createDatabase();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      UPDATE products SET fulfillment_type = 'license_key' WHERE id = 'product_attribution_web_free';
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('seller_attribution_free', 'seller-free@example.test', 'Seller Free', 'active', '${now}', '${now}');
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, filename_sanitized, total_count,
        accepted_count, rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_attribution_free', 'shop_attribution_a', 'variant_attribution_web_free',
        'paste', NULL, 1, 1, 0, 'seller_attribution_free', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'inventory_attribution_free', 'shop_attribution_a', 'variant_attribution_web_free',
        'batch_attribution_free', 'available', 'ciphertext', 'iv', 'v1',
        'fingerprint-attribution-free', '${now}'
      );
    `);
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const shop = storefrontShop();
    const cart = await createCart({
      env,
      items: [{ quantity: 1, variantId: "variant_attribution_web_free" }],
      locale: "vi",
      shop,
    });
    const quote = await quoteCart({ cartId: cart.cartId, cartToken: cart.cartToken, env, shop });
    const expected = quote.items as Array<{ quantity: number; unitPriceMinor: number; variantId: string; variantVersion: number }>;
    const order = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: null,
      env,
      expected,
      idempotencyKey: "checkout-attribution-web-free-0001",
      shop,
    });

    expect(order).toMatchObject({ currency: "VND", fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed", totalMinor: 0 });
    expect(typeof order.orderNumber).toBe("string");
    const fulfillment = database.database.prepare("SELECT fulfillment_type AS fulfillmentType, state FROM fulfillments WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE public_id = ?)").get(shop.id, order.orderId);
    expect(fulfillment).toEqual({ fulfillmentType: "digital_keys", state: "fulfilled" });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM fulfillment_items WHERE shop_id = ? AND fulfillment_id = (SELECT id FROM fulfillments WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE public_id = ?))").get(shop.id, shop.id, order.orderId)).toEqual({ count: 1 });
    const soldKey = database.database.prepare("SELECT status, sold_order_item_id FROM inventory_keys WHERE shop_id = ? AND id = 'inventory_attribution_free'").get(shop.id) as { sold_order_item_id: string | null; status: string };
    expect(soldKey.status).toBe("sold");
    expect(typeof soldKey.sold_order_item_id).toBe("string");
    const events = database.database.prepare(`
      SELECT domain_events.event_type AS eventType,
        domain_events.idempotency_key_hash AS idempotencyHash,
        domain_events.source_connection_id AS sourceConnectionId,
        domain_events.status
      FROM domain_events
      INNER JOIN orders ON orders.id = domain_events.aggregate_id
      WHERE orders.public_id = ?
      ORDER BY domain_events.event_type
    `).all(order.orderId) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual(["order.created", "order.paid"]);
    for (const event of events) {
      expect(event).toMatchObject({ sourceConnectionId: null, status: "pending" });
      expect(String(event.idempotencyHash)).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(events[0]?.idempotencyHash).not.toBe(events[1]?.idempotencyHash);
  });

  it("keeps Telegram checkout behavior while dual-writing normalized attribution", async () => {
    const database = createDatabase();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_attribution_telegram', 'shop_attribution_b', 'telegram-product',
        'Telegram product', '', 'active', 'manual', 1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_attribution_telegram', 'shop_attribution_b',
        'product_attribution_telegram', 'TELEGRAM-ATTR', 'Default', '{}', 2000,
        'VND', 1, 5, 'active', 1, '${now}', '${now}'
      );
      INSERT INTO shop_customers (
        id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at
      ) VALUES (
        'customer_attribution_telegram', 'shop_attribution_b', NULL,
        'Telegram customer', 'vi', 'active', '${now}', '${now}'
      );
      INSERT INTO telegram_integrations (
        id, public_id, webhook_public_id, shop_id, status, webhook_status,
        created_at, updated_at
      ) VALUES (
        'integration_attribution_telegram', 'integration_public_attribution_telegram',
        'webhook_public_attribution_telegram', 'shop_attribution_b', 'active',
        'verified', '${now}', '${now}'
      );
      INSERT INTO carts (
        id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at
      ) VALUES (
        'cart_attribution_telegram', 'shop_attribution_b', 'telegram',
        'subject-attribution-telegram', 'vi', 'active',
        '2099-07-26T00:00:00.000Z', '${now}', '${now}'
      );
      INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (
        'cart_attribution_telegram', 'shop_attribution_b',
        'variant_attribution_telegram', 1
      );
    `);
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const identity: TelegramIdentity = {
      chatId: "123456789",
      customerId: "customer_attribution_telegram",
      identityId: "identity_attribution_telegram",
      subjectHash: "subject-attribution-telegram",
    };
    const shop: TelegramShop = {
      currency: "VND",
      defaultLocale: "vi",
      id: "shop_attribution_b",
      name: "Attribution B",
      orderExpiryMinutes: 30,
      origin: "https://attribution-b.selinow.com",
      status: "active",
      subscriptionState: "active",
    };
    await seedTelegramQuote({ cartId: "cart_attribution_telegram", env, identity, integrationId: "integration_attribution_telegram", shop, updateId: 1001 });
    const order = await checkoutTelegramCart({
      env,
      identity,
      integrationId: "integration_attribution_telegram",
      quoteUpdateId: 1001,
      shop,
      updateId: 1001,
    });

    expect(order).toMatchObject({ paymentStatus: "unpaid", status: "pending_payment", totalMinor: 2000 });
    const linkedConnection = database.database.prepare(`
      SELECT channel_connection_id AS connectionId
      FROM telegram_integrations WHERE id = ?
    `).get("integration_attribution_telegram") as { connectionId: string };
    expect(database.database.prepare(`
      SELECT orders.source_channel AS sourceChannel,
        order_channel_attributions.channel_code AS channelCode,
        order_channel_attributions.adapter_version AS adapterVersion,
        order_channel_attributions.connection_id AS connectionId
      FROM orders
      INNER JOIN order_channel_attributions
        ON order_channel_attributions.shop_id = orders.shop_id
        AND order_channel_attributions.order_id = orders.id
      WHERE orders.public_id = ?
    `).get(order.orderId)).toEqual({
      adapterVersion: 1,
      channelCode: "telegram",
      connectionId: linkedConnection.connectionId,
      sourceChannel: "telegram",
    });
    const telegramEvent = database.database.prepare(`
      SELECT domain_events.event_type AS eventType,
        domain_events.idempotency_key_hash AS idempotencyHash,
        domain_events.source_connection_id AS sourceConnectionId,
        domain_events.status
      FROM domain_events
      INNER JOIN orders ON orders.id = domain_events.aggregate_id
      WHERE orders.public_id = ?
    `).get(order.orderId) as Record<string, unknown>;
    expect(telegramEvent).toMatchObject({
      eventType: "order.created",
      sourceConnectionId: linkedConnection.connectionId,
      status: "pending",
    });
    expect(telegramEvent.sourceConnectionId).toBe(linkedConnection.connectionId);
    expect(String(telegramEvent.idempotencyHash)).toMatch(/^[0-9a-f]{64}$/u);

    const checkoutKey = await createTelegramCheckoutApplicationKey(env, shop.id, "integration_attribution_telegram", 1001);
    const context = {
      actor: { customerId: identity.customerId, kind: "customer" as const },
      channel: { code: TELEGRAM_CHANNEL_CODE, connectionId: linkedConnection.connectionId },
      locale: shop.defaultLocale,
      requestId: checkoutKey,
      shopId: shop.id,
    };
    const orderApplication = createTelegramCheckoutApplication({
      connectionId: linkedConnection.connectionId,
      env,
      expectedIdempotencyKey: checkoutKey,
      identity: { ...identity, integrationId: "integration_attribution_telegram" },
      requestedSnapshot: null,
      shop,
      updateId: 1001,
    });
    await expect(orderApplication.listOrders(context, {})).resolves.toEqual([expect.objectContaining({ orderId: order.orderId })]);
    await expect(orderApplication.getOrder(context, { order: { access: { kind: "principal" }, orderId: order.orderId } })).resolves.toMatchObject({ orderNumber: order.orderNumber });

    database.database.prepare(`
      UPDATE order_channel_attributions
      SET adapter_version = 2
      WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE public_id = ? AND shop_id = ?)
    `).run(shop.id, order.orderId, shop.id);
    await expect(orderApplication.listOrders(context, {})).resolves.toEqual([]);
    await expect(orderApplication.getOrder(context, { order: { access: { kind: "principal" }, orderId: order.orderId } })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    await expect(checkoutTelegramCart({
      env,
      identity,
      integrationId: "integration_attribution_telegram",
      quoteUpdateId: 1001,
      shop,
      updateId: 1001,
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("emits order.created and order.paid atomically for a free Telegram checkout", async () => {
    const database = createDatabase();
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_attribution_telegram_free', 'shop_attribution_b',
        'telegram-free-product', 'Telegram free product', '', 'active', 'manual',
        1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_attribution_telegram_free', 'shop_attribution_b',
        'product_attribution_telegram_free', 'TELEGRAM-FREE', 'Default', '{}', 0,
        'VND', 1, 5, 'active', 1, '${now}', '${now}'
      );
      INSERT INTO shop_customers (
        id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at
      ) VALUES (
        'customer_attribution_telegram_free', 'shop_attribution_b', NULL,
        'Telegram free customer', 'vi', 'active', '${now}', '${now}'
      );
      INSERT INTO telegram_integrations (
        id, public_id, webhook_public_id, shop_id, status, webhook_status,
        created_at, updated_at
      ) VALUES (
        'integration_attribution_telegram_free',
        'integration_public_attribution_telegram_free',
        'webhook_public_attribution_telegram_free', 'shop_attribution_b', 'active',
        'verified', '${now}', '${now}'
      );
      INSERT INTO carts (
        id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at
      ) VALUES (
        'cart_attribution_telegram_free', 'shop_attribution_b', 'telegram',
        'subject-attribution-telegram-free', 'vi', 'active',
        '2099-07-26T00:00:00.000Z', '${now}', '${now}'
      );
      INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (
        'cart_attribution_telegram_free', 'shop_attribution_b',
        'variant_attribution_telegram_free', 1
      );
    `);
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const identity: TelegramIdentity = {
      chatId: "987654321",
      customerId: "customer_attribution_telegram_free",
      identityId: "identity_attribution_telegram_free",
      subjectHash: "subject-attribution-telegram-free",
    };
    const shop: TelegramShop = {
      currency: "VND",
      defaultLocale: "vi",
      id: "shop_attribution_b",
      name: "Attribution B",
      orderExpiryMinutes: 30,
      origin: "https://attribution-b.selinow.com",
      status: "active",
      subscriptionState: "active",
    };
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_free", env, identity, integrationId: "integration_attribution_telegram_free", shop, updateId: 1002 });
    const order = await checkoutTelegramCart({
      env,
      identity,
      integrationId: "integration_attribution_telegram_free",
      quoteUpdateId: 1002,
      shop,
      updateId: 1002,
    });

    expect(order).toMatchObject({
      fulfillmentStatus: "unfulfilled",
      paymentStatus: "paid",
      status: "processing",
      totalMinor: 0,
    });
    expect(database.database.prepare(`
      SELECT paid_at AS paidAt, fulfilled_at AS fulfilledAt
      FROM orders WHERE shop_id = ? AND public_id = ?
    `).get(shop.id, order.orderId)).toMatchObject({ fulfilledAt: null });
    expect(database.database.prepare(`
      SELECT fulfillment_type AS fulfillmentType, state
      FROM fulfillments
      WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE shop_id = ? AND public_id = ?)
    `).get(shop.id, shop.id, order.orderId)).toEqual({ fulfillmentType: "manual", state: "pending" });
    const linkedConnection = database.database.prepare(`
      SELECT channel_connection_id AS connectionId
      FROM telegram_integrations WHERE id = ?
    `).get("integration_attribution_telegram_free") as { connectionId: string };
    const events = database.database.prepare(`
      SELECT domain_events.event_type AS eventType,
        domain_events.idempotency_key_hash AS idempotencyHash,
        domain_events.source_connection_id AS sourceConnectionId,
        domain_events.status
      FROM domain_events
      INNER JOIN orders ON orders.id = domain_events.aggregate_id
      WHERE orders.public_id = ?
      ORDER BY domain_events.event_type
    `).all(order.orderId) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual(["order.created", "order.paid"]);
    for (const event of events) {
      expect(event).toMatchObject({
        sourceConnectionId: linkedConnection.connectionId,
        status: "pending",
      });
      expect(String(event.idempotencyHash)).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(events[0]?.idempotencyHash).not.toBe(events[1]?.idempotencyHash);
  });

  it("rejects a mixed free Telegram order without partial fulfillment", async () => {
    const database = createDatabase();
    const now = "2026-07-26T00:00:00.000Z";
    seedTelegramCheckout(database, {
      cartId: "cart_attribution_telegram_mixed",
      integrationId: "integration_attribution_telegram_mixed",
      productId: "product_attribution_telegram_mixed_manual",
      subjectHash: "subject-attribution-telegram-mixed",
      variantId: "variant_attribution_telegram_mixed_manual",
      variantPrice: 0,
    });
    database.database.exec(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product_attribution_telegram_mixed_license', 'shop_attribution_b',
        'telegram-mixed-license', 'Telegram mixed license', '', 'active',
        'license_key', 1, '${now}', '${now}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant_attribution_telegram_mixed_license', 'shop_attribution_b',
        'product_attribution_telegram_mixed_license', 'TELEGRAM-MIXED-LICENSE',
        'Default', '{}', 0, 'VND', 1, 5, 'active', 1, '${now}', '${now}'
      );
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES (
        'seller_attribution_telegram_mixed', 'seller-telegram-mixed@example.test',
        'Seller Telegram Mixed', 'active', '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, filename_sanitized, total_count,
        accepted_count, rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_attribution_telegram_mixed', 'shop_attribution_b',
        'variant_attribution_telegram_mixed_license', 'paste', NULL, 1, 1, 0,
        'seller_attribution_telegram_mixed', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'inventory_attribution_telegram_mixed', 'shop_attribution_b',
        'variant_attribution_telegram_mixed_license',
        'batch_attribution_telegram_mixed', 'available', 'ciphertext', 'iv',
        'v1', 'fingerprint-attribution-telegram-mixed', '${now}'
      );
      INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (
        'cart_attribution_telegram_mixed', 'shop_attribution_b',
        'variant_attribution_telegram_mixed_license', 1
      );
    `);
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const identity: TelegramIdentity = {
      chatId: "999888777",
      customerId: "product_attribution_telegram_mixed_manual-customer",
      identityId: "identity-attribution-telegram-mixed",
      subjectHash: "subject-attribution-telegram-mixed",
    };
    const shop = telegramShop();
    const ordersBefore = database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(shop.id);

    await seedTelegramQuote({ cartId: "cart_attribution_telegram_mixed", env, identity, integrationId: "integration_attribution_telegram_mixed", shop, updateId: 1007 });
    await expect(checkoutTelegramCart({
      env,
      identity,
      integrationId: "integration_attribution_telegram_mixed",
      quoteUpdateId: 1007,
      shop,
      updateId: 1007,
    })).rejects.toMatchObject({
      code: "mixed_fulfillment_unsupported",
      status: 409,
    });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(shop.id)).toEqual(ordersBefore);
    expect(database.database.prepare("SELECT status FROM inventory_keys WHERE shop_id = ? AND id = ?").get(shop.id, "inventory_attribution_telegram_mixed")).toEqual({ status: "available" });
  });

  it("replays a Telegram checkout after the original cart is converted", async () => {
    const database = createDatabase();
    seedTelegramCheckout(database, {
      cartId: "cart_attribution_telegram_replay",
      integrationId: "integration_attribution_telegram_replay",
      productId: "product_attribution_telegram_replay",
      subjectHash: "subject-attribution-telegram-replay",
      variantId: "variant_attribution_telegram_replay",
      variantPrice: 2000,
    });
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const identity: TelegramIdentity = {
      chatId: "111222333",
      customerId: "product_attribution_telegram_replay-customer",
      identityId: "identity-attribution-telegram-replay",
      subjectHash: "subject-attribution-telegram-replay",
    };
    const shop = telegramShop();
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_replay", env, identity, integrationId: "integration_attribution_telegram_replay", shop, updateId: 1003 });
    const input = {
      env,
      identity,
      integrationId: "integration_attribution_telegram_replay",
      quoteUpdateId: 1003,
      shop,
      updateId: 1003,
    };

    const first = await checkoutTelegramCart(input);
    const replay = await checkoutTelegramCart(input);

    expect(replay).toEqual(first);
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ? AND checkout_subject_hash = (SELECT checkout_subject_hash FROM orders WHERE public_id = ?)").get(shop.id, first.orderId)).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get("cart_attribution_telegram_replay", shop.id)).toEqual({ state: "converted" });

    database.database.prepare("UPDATE cart_items SET quantity = 2 WHERE cart_id = ? AND shop_id = ?").run("cart_attribution_telegram_replay", shop.id);
    await expect(checkoutTelegramCart(input)).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("does not replay a Telegram checkout result across principals", async () => {
    const database = createDatabase();
    seedTelegramCheckout(database, {
      cartId: "cart_attribution_telegram_principal_replay",
      integrationId: "integration_attribution_telegram_principal_replay",
      productId: "product_attribution_telegram_principal_replay",
      subjectHash: "subject-attribution-telegram-principal-replay",
      variantId: "variant_attribution_telegram_principal_replay",
      variantPrice: 2000,
    });
    database.database.prepare(`
      INSERT INTO shop_customers (
        id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 'vi', 'active', ?, ?)
    `).run(
      "customer_attribution_telegram_intruder",
      "shop_attribution_b",
      "Intruder",
      "2026-07-26T00:00:00.000Z",
      "2026-07-26T00:00:00.000Z",
    );
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const shop = telegramShop();
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_principal_replay", env, identity: {
      chatId: "111222333",
      customerId: "product_attribution_telegram_principal_replay-customer",
      identityId: "identity-attribution-telegram-principal-replay",
      subjectHash: "subject-attribution-telegram-principal-replay",
    }, integrationId: "integration_attribution_telegram_principal_replay", shop, updateId: 1011 });
    const originalInput = {
      env,
      identity: {
        chatId: "111222333",
        customerId: "product_attribution_telegram_principal_replay-customer",
        identityId: "identity-attribution-telegram-principal-replay",
        subjectHash: "subject-attribution-telegram-principal-replay",
      },
      integrationId: "integration_attribution_telegram_principal_replay",
      quoteUpdateId: 1011,
      shop,
      updateId: 1011,
    };

    const original = await checkoutTelegramCart(originalInput);
    await expect(checkoutTelegramCart({
      ...originalInput,
      identity: {
        ...originalInput.identity,
        customerId: "customer_attribution_telegram_intruder",
        subjectHash: "subject-attribution-telegram-intruder",
      },
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ? AND checkout_subject_hash = (SELECT checkout_subject_hash FROM orders WHERE public_id = ?)").get(shop.id, original.orderId)).toEqual({ count: 1 });
    expect(original.orderId).toMatch(/^order_/u);
  });

  it("replays an older Telegram checkout after the buyer completes a newer cart", async () => {
    const database = createDatabase();
    seedTelegramCheckout(database, {
      cartId: "cart_attribution_telegram_old_replay",
      integrationId: "integration_attribution_telegram_old_replay",
      productId: "product_attribution_telegram_old_replay",
      subjectHash: "subject-attribution-telegram-old-replay",
      variantId: "variant_attribution_telegram_old_replay",
      variantPrice: 2000,
    });
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const identity: TelegramIdentity = {
      chatId: "777888999",
      customerId: "product_attribution_telegram_old_replay-customer",
      identityId: "identity-attribution-telegram-old-replay",
      subjectHash: "subject-attribution-telegram-old-replay",
    };
    const shop = telegramShop();
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_old_replay", env, identity, integrationId: "integration_attribution_telegram_old_replay", shop, updateId: 1005 });
    const originalInput = {
      env,
      identity,
      integrationId: "integration_attribution_telegram_old_replay",
      quoteUpdateId: 1005,
      shop,
      updateId: 1005,
    };
    const original = await checkoutTelegramCart(originalInput);
    // Simulate a pre-0030 order whose exact cart reference was not persisted.
    database.database.prepare("UPDATE orders SET checkout_cart_id = NULL WHERE public_id = ? AND shop_id = ?").run(original.orderId, shop.id);
    database.database.exec(`
      INSERT INTO carts (
        id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at
      ) VALUES (
        'cart_attribution_telegram_newer', 'shop_attribution_b', 'telegram',
        'subject-attribution-telegram-old-replay', 'vi', 'active',
        '2099-07-26T00:00:00.000Z', '2026-07-26T00:01:00.000Z',
        '2026-07-26T00:01:00.000Z'
      );
      INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (
        'cart_attribution_telegram_newer', 'shop_attribution_b',
        'variant_attribution_telegram_old_replay', 1
      );
    `);
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_newer", env, identity, integrationId: "integration_attribution_telegram_old_replay", shop, updateId: 1006 });
    const newer = await checkoutTelegramCart({ ...originalInput, quoteUpdateId: 1006, updateId: 1006 });
    database.database.prepare(
      "UPDATE carts SET updated_at = ? WHERE id = ? AND shop_id = ? AND state = 'converted'",
    ).run("2099-07-26T00:00:00.000Z", "cart_attribution_telegram_newer", shop.id);

    await expect(checkoutTelegramCart(originalInput)).resolves.toEqual(original);
    expect(newer.orderId).not.toBe(original.orderId);
    expect(database.database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE shop_id = ? AND checkout_subject_hash IS NOT NULL",
    ).get(shop.id)).toEqual({ count: 3 });
  });

  it("rejects a Telegram checkout command whose expected catalog snapshot differs", async () => {
    const database = createDatabase();
    seedTelegramCheckout(database, {
      cartId: "cart_attribution_telegram_expected",
      integrationId: "integration_attribution_telegram_expected",
      productId: "product_attribution_telegram_expected",
      subjectHash: "subject-attribution-telegram-expected",
      variantId: "variant_attribution_telegram_expected",
      variantPrice: 2000,
    });
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const identity: TelegramIdentity = {
      chatId: "111111222",
      customerId: "product_attribution_telegram_expected-customer",
      identityId: "identity-attribution-telegram-expected",
      subjectHash: "subject-attribution-telegram-expected",
    };
    const shop = telegramShop();
    const quoteEvidence = await seedTelegramQuote({ cartId: "cart_attribution_telegram_expected", env, identity, integrationId: "integration_attribution_telegram_expected", shop, updateId: 1008 });
    const checkoutKey = await createTelegramCheckoutApplicationKey(env, shop.id, "integration_attribution_telegram_expected", 1008);
    const snapshot = await resolveTelegramCheckoutSnapshot({
      checkoutKey,
      connectionId: null,
      env,
      identity,
      shop,
    });
    if (snapshot === null) throw new Error("telegram_expected_snapshot_missing");
    const application = createTelegramCheckoutApplication({
      connectionId: null,
      env,
      expectedIdempotencyKey: checkoutKey,
      identity: { ...identity, integrationId: "integration_attribution_telegram_expected" },
      requestedSnapshot: snapshot,
      shop,
      updateId: 1008,
    });
    const context = {
      actor: { customerId: identity.customerId, kind: "customer" as const },
      channel: { code: TELEGRAM_CHANNEL_CODE, connectionId: null },
      locale: shop.defaultLocale,
      requestId: checkoutKey,
      shopId: shop.id,
    };
    await expect(application.checkoutCart(context, {
      cart: { access: { kind: "principal" }, cartId: snapshot.cartId },
      customerEmail: null,
      expected: snapshot.lines.map((line) => ({ quantity: line.quantity, unitPriceMinor: line.priceMinor + 1, variantId: line.variantId, variantVersion: line.version })),
      idempotencyKey: checkoutKey,
      quoteEvidence,
    })).rejects.toMatchObject({ code: "checkout_changed", status: 409 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ? AND checkout_subject_hash = ?").get(shop.id, checkoutKey)).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND status = 'reserved'").get(shop.id)).toEqual({ count: 0 });
  });

  it("rejects a paid non-VND Telegram checkout before order or inventory reservation writes", async () => {
    const database = createDatabase();
    const productId = "product_attribution_telegram_non_vnd";
    const variantId = "variant_attribution_telegram_non_vnd";
    database.database.prepare("UPDATE shops SET currency = 'USD' WHERE id = ?").run("shop_attribution_b");
    seedTelegramCheckout(database, {
      cartId: "cart_attribution_telegram_non_vnd",
      integrationId: "integration_attribution_telegram_non_vnd",
      productId,
      subjectHash: "subject-attribution-telegram-non-vnd",
      variantCurrency: "USD",
      variantId,
      variantPrice: 2000,
    });
    const now = "2026-07-26T00:00:00.000Z";
    database.database.exec(`
      UPDATE products SET fulfillment_type = 'license_key'
      WHERE id = '${productId}' AND shop_id = 'shop_attribution_b';
      INSERT INTO platform_users (
        id, email_normalized, display_name, status, created_at, updated_at
      ) VALUES (
        'user_non_vnd_telegram', 'non-vnd-telegram@example.test', 'Non VND Telegram',
        'active', '${now}', '${now}'
      );
      INSERT INTO inventory_batches (
        id, shop_id, variant_id, source, filename_sanitized,
        total_count, accepted_count, rejected_count, created_by_user_id, created_at
      ) VALUES (
        'batch_non_vnd_telegram', 'shop_attribution_b', '${variantId}',
        'paste', NULL, 1, 1, 0, 'user_non_vnd_telegram', '${now}'
      );
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (
        'inventory_non_vnd_telegram', 'shop_attribution_b', '${variantId}',
        'batch_non_vnd_telegram', 'available', 'ciphertext', 'iv', 'v1',
        'fingerprint-non-vnd-telegram', '${now}'
      );
    `);
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const shop = { ...telegramShop(), currency: "USD" };
    const identity: TelegramIdentity = {
      chatId: "909090909",
      customerId: `${productId}-customer`,
      identityId: "identity-attribution-telegram-non-vnd",
      subjectHash: "subject-attribution-telegram-non-vnd",
    };
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_non_vnd", env, identity, integrationId: "integration_attribution_telegram_non_vnd", shop, updateId: 1011 });
    const orderCountBefore = database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(shop.id);

    await expect(checkoutTelegramCart({
      env,
      identity,
      integrationId: "integration_attribution_telegram_non_vnd",
      quoteUpdateId: 1011,
      shop,
      updateId: 1011,
    })).rejects.toMatchObject({
      code: "payment_currency_unsupported",
      issues: undefined,
      status: 409,
    });

    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(shop.id)).toEqual(orderCountBefore);
    expect(database.database.prepare("SELECT status, reservation_token AS reservationToken, reserved_order_item_id AS reservedOrderItemId FROM inventory_keys WHERE id = ? AND shop_id = ?").get("inventory_non_vnd_telegram", shop.id)).toEqual({ reservationToken: null, reservedOrderItemId: null, status: "available" });
    expect(database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get("cart_attribution_telegram_non_vnd", shop.id)).toEqual({ state: "active" });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM telegram_actions WHERE shop_id = ? AND integration_id = ? AND update_id = ? AND action_kind = 'checkout'").get(shop.id, "integration_attribution_telegram_non_vnd", 1011)).toEqual({ count: 0 });
  });

  it("rejects a concurrent Telegram checkout when the request hash differs", async () => {
    const database = createDatabase();
    seedTelegramCheckout(database, {
      cartId: "cart_attribution_telegram_conflict",
      integrationId: "integration_attribution_telegram_conflict",
      productId: "product_attribution_telegram_conflict",
      subjectHash: "subject-attribution-telegram-conflict",
      variantId: "variant_attribution_telegram_conflict",
      variantPrice: 2000,
    });
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const identity: TelegramIdentity = {
      chatId: "444555666",
      customerId: "product_attribution_telegram_conflict-customer",
      identityId: "identity-attribution-telegram-conflict",
      subjectHash: "subject-attribution-telegram-conflict",
    };
    const shop = telegramShop();
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_conflict", env, identity, integrationId: "integration_attribution_telegram_conflict", shop, updateId: 1004 });
    const gate = database.pauseNextVariantRead();
    const input = {
      env,
      identity,
      integrationId: "integration_attribution_telegram_conflict",
      quoteUpdateId: 1004,
      shop,
      updateId: 1004,
    };
    const staleCheckout = checkoutTelegramCart(input);

    await gate.reached;
    database.database.prepare("UPDATE cart_items SET quantity = 2 WHERE cart_id = ? AND shop_id = ? AND variant_id = ?").run("cart_attribution_telegram_conflict", shop.id, "variant_attribution_telegram_conflict");
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_conflict", env, identity, integrationId: "integration_attribution_telegram_conflict", shop, updateId: 1005 });
    const winner = await checkoutTelegramCart({ ...input, quoteUpdateId: 1005 });
    gate.resume();

    await expect(staleCheckout).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(winner).toMatchObject({ totalMinor: 4000, status: "pending_payment" });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ? AND checkout_subject_hash = (SELECT checkout_subject_hash FROM orders WHERE public_id = ?)").get(shop.id, winner.orderId)).toEqual({ count: 1 });
  });

  it("replays a concurrent Telegram checkout with the same idempotency payload", async () => {
    const database = createDatabase();
    seedTelegramCheckout(database, {
      cartId: "cart_attribution_telegram_same_replay",
      integrationId: "integration_attribution_telegram_same_replay",
      productId: "product_attribution_telegram_same_replay",
      subjectHash: "subject-attribution-telegram-same-replay",
      variantId: "variant_attribution_telegram_same_replay",
      variantPrice: 2000,
    });
    const env = {
      IDENTIFIER_HMAC_SECRET: "channel-attribution-test-secret",
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings;
    const identity: TelegramIdentity = {
      chatId: "111333555",
      customerId: "product_attribution_telegram_same_replay-customer",
      identityId: "identity-attribution-telegram-same-replay",
      subjectHash: "subject-attribution-telegram-same-replay",
    };
    const shop = telegramShop();
    await seedTelegramQuote({ cartId: "cart_attribution_telegram_same_replay", env, identity, integrationId: "integration_attribution_telegram_same_replay", shop, updateId: 1010 });
    const gate = database.pauseNextVariantRead();
    const input = {
      env,
      identity,
      integrationId: "integration_attribution_telegram_same_replay",
      quoteUpdateId: 1010,
      shop,
      updateId: 1010,
    };
    const blocked = checkoutTelegramCart(input);
    await gate.reached;
    const winner = await checkoutTelegramCart(input);
    gate.resume();

    await expect(blocked).resolves.toEqual(winner);
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ? AND checkout_subject_hash = (SELECT checkout_subject_hash FROM orders WHERE public_id = ?)").get(shop.id, winner.orderId)).toEqual({ count: 1 });
  });
});
