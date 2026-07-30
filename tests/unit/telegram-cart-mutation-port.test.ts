import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { CommerceApplicationService } from "../../src/lib/commerce/application";
import {
  createTelegramCartMutationApplicationKey,
  loadTelegramQuoteAction,
  persistTelegramQuoteAction,
  TelegramCartMutationPort,
} from "../../src/lib/commerce/telegram-port";
import type { AppBindings } from "../../src/lib/platform/bindings";

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
const NOW = "2026-07-29T00:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createRuntime(): { database: SqliteD1; env: AppBindings } {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    sqlite.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES
      ('shop-telegram', 'shop-public-telegram', 'telegram-shop', 'Telegram Shop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop-other', 'shop-public-other', 'other-shop', 'Other Shop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
    INSERT INTO telegram_integrations (id, public_id, webhook_public_id, shop_id, status, webhook_status, created_at, updated_at)
    VALUES
      ('integration-telegram', 'integration-public-telegram', 'webhook-public-telegram', 'shop-telegram', 'active', 'verified', '${NOW}', '${NOW}'),
      ('integration-other', 'integration-public-other', 'webhook-public-other', 'shop-other', 'active', 'verified', '${NOW}', '${NOW}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES ('product-telegram', 'shop-telegram', 'manual-product', 'Manual Product', '', 'active', 'manual', 1, '${NOW}', '${NOW}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES ('variant-telegram', 'shop-telegram', 'product-telegram', 'SKU-TELEGRAM', 'Default', '{}', 1000, 'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}');
    INSERT INTO discounts (id, shop_id, code_normalized, type, value, currency, minimum_minor, status, created_at, updated_at)
    VALUES ('discount-telegram', 'shop-telegram', 'WELCOME10', 'percentage', 1000, 'VND', 0, 'active', '${NOW}', '${NOW}');
  `);
  const database = new SqliteD1(sqlite);
  const env = {
    IDENTIFIER_HMAC_SECRET: "telegram-cart-mutation-secret",
    PLATFORM_DB: database as unknown as D1Database,
  } as unknown as AppBindings;
  return { database, env };
}

describe("Telegram canonical cart mutation port", () => {
  it("adds once and replays the same idempotent mutation without a second quantity increment", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const identity = { customerId: "customer-telegram", subjectHash: "subject-telegram" };
    const integrationId = "integration-telegram";
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, 101);
    const context = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity, integrationId, shop, updateId: 101 }));
    const command = { cart: { access: { kind: "principal" as const }, cartId: null }, idempotencyKey: key, mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-telegram" } };

    const first = await application.mutateCart(context, command);
    const replay = await application.mutateCart(context, command);

    expect(first).toMatchObject({ replayed: false, cart: { access: { kind: "principal" } } });
    expect(replay).toEqual({ cart: first.cart, replayed: true });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE shop_id = ? AND cart_id = ? AND variant_id = ?").get("shop-telegram", first.cart.cartId, "variant-telegram")).toEqual({ quantity: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM telegram_actions WHERE shop_id = ? AND integration_id = ? AND update_id = ?").get("shop-telegram", integrationId, 101)).toEqual({ count: 1 });
  });

  it("fails closed when the same opaque mutation key is reused with a different payload", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const identity = { customerId: "customer-telegram", subjectHash: "subject-telegram" };
    const integrationId = "integration-telegram";
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, 102);
    const context = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity, integrationId, shop, updateId: 102 }));
    const firstCommand = { cart: { access: { kind: "principal" as const }, cartId: null }, idempotencyKey: key, mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-telegram" } };
    await application.mutateCart(context, firstCommand);

    await expect(application.mutateCart(context, { ...firstCommand, mutation: { kind: "item.increment", quantity: 2, variantId: "variant-telegram" } })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE shop_id = ?").get("shop-telegram")).toEqual({ quantity: 1 });
  });

  it("applies discount through the same principal port and keeps provider identifiers outside the canonical command", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const identity = { customerId: "customer-telegram", subjectHash: "subject-telegram" };
    const integrationId = "integration-telegram";
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, 103);
    const context = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity, integrationId, shop, updateId: 103 }));
    const command = { cart: { access: { kind: "principal" as const }, cartId: null }, idempotencyKey: key, mutation: { code: "WELCOME10", kind: "discount.apply" as const } };

    const result = await application.mutateCart(context, command);
    const replay = await application.mutateCart(context, command);

    expect(result.replayed).toBe(false);
    expect(replay).toEqual({ cart: result.cart, replayed: true });
    expect(runtime.database.database.prepare("SELECT discount_code_normalized AS code FROM carts WHERE shop_id = ? AND id = ?").get("shop-telegram", result.cart.cartId)).toEqual({ code: "WELCOME10" });
    const serialized = JSON.stringify(command);
    expect(serialized).not.toContain("integrationId");
    expect(serialized).not.toContain("updateId");
    expect(serialized).not.toContain("subjectHash");
  });

  it("rejects a cart mutation context bound to another tenant before any write", async () => {
    const runtime = createRuntime();
    const key = await createTelegramCartMutationApplicationKey(runtime.env, "shop-telegram", "integration-telegram", 104);
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity: { customerId: "customer-telegram", subjectHash: "subject-telegram" }, integrationId: "integration-telegram", shop: { currency: "VND", defaultLocale: "vi", id: "shop-telegram" }, updateId: 104 }));
    const command = { cart: { access: { kind: "principal" as const }, cartId: null }, idempotencyKey: key, mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-telegram" } };

    await expect(application.mutateCart({ actor: { customerId: "customer-telegram", kind: "customer" }, channel: { code: "telegram", connectionId: null }, locale: "vi", requestId: key, shopId: "shop-other" }, command)).rejects.toMatchObject({ code: "commerce_context_mismatch", status: 403 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM carts").get()).toEqual({ count: 0 });
  });

  it("rejects a foreign integration at every direct cart and quote-action boundary", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const identity = { customerId: "customer-telegram", subjectHash: "subject-foreign-integration" };
    const foreignIntegrationId = "integration-other";
    const foreignCreateKey = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, foreignIntegrationId, 120);
    const foreignContext = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: foreignCreateKey, shopId: shop.id };
    const foreignCreateApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: foreignCreateKey, identity, integrationId: foreignIntegrationId, shop, updateId: 120 }));

    await expect(foreignCreateApplication.createCart(foreignContext, {
      items: [{ quantity: 1, variantId: "variant-telegram" }],
    })).rejects.toMatchObject({ code: "commerce_context_mismatch", issues: ["telegram_integration_required"], status: 403 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM carts").get()).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM telegram_actions").get()).toEqual({ count: 0 });

    const ownerIntegrationId = "integration-telegram";
    const ownerKey = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, ownerIntegrationId, 121);
    const ownerContext = { ...foreignContext, requestId: ownerKey };
    const ownerApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: ownerKey, identity, integrationId: ownerIntegrationId, shop, updateId: 121 }));
    const ownerCart = await ownerApplication.createCart(ownerContext, { items: [{ quantity: 1, variantId: "variant-telegram" }] });
    const ownerQuote = await ownerApplication.quoteCart(ownerContext, { cart: { access: { kind: "principal" }, cartId: ownerCart.cartId } });
    await persistTelegramQuoteAction({ cartId: ownerCart.cartId, discountCode: null, env: runtime.env, identity, integrationId: ownerIntegrationId, quote: ownerQuote, shop, updateId: 121 });

    const foreignMutationKey = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, foreignIntegrationId, 122);
    const foreignMutationContext = { ...foreignContext, requestId: foreignMutationKey };
    const foreignMutationApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: foreignMutationKey, identity, integrationId: foreignIntegrationId, shop, updateId: 122 }));
    await expect(foreignMutationApplication.mutateCart(foreignMutationContext, {
      cart: { access: { kind: "principal" }, cartId: null },
      idempotencyKey: foreignMutationKey,
      mutation: { kind: "item.increment", quantity: 1, variantId: "variant-telegram" },
    })).rejects.toMatchObject({ code: "commerce_context_mismatch", issues: ["telegram_integration_required"], status: 403 });
    await expect(foreignMutationApplication.quoteCart(foreignMutationContext, {
      cart: { access: { kind: "principal" }, cartId: ownerCart.cartId },
    })).rejects.toMatchObject({ code: "commerce_context_mismatch", issues: ["telegram_integration_required"], status: 403 });
    await expect(persistTelegramQuoteAction({
      cartId: ownerCart.cartId,
      discountCode: null,
      env: runtime.env,
      identity,
      integrationId: foreignIntegrationId,
      quote: ownerQuote,
      shop,
      updateId: 122,
    })).rejects.toMatchObject({ code: "commerce_context_mismatch", issues: ["telegram_integration_required"], status: 403 });
    await expect(loadTelegramQuoteAction({
      env: runtime.env,
      identity,
      integrationId: foreignIntegrationId,
      shopId: shop.id,
      updateId: 121,
    })).rejects.toMatchObject({ code: "commerce_context_mismatch", issues: ["telegram_integration_required"], status: 403 });

    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ?").get(ownerCart.cartId, shop.id)).toEqual({ quantity: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM carts WHERE shop_id = ?").get(shop.id)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM carts WHERE shop_id = 'shop-other'").get()).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM telegram_actions WHERE integration_id = ?").get(foreignIntegrationId)).toEqual({ count: 0 });
  });

  it("projects a principal cart quote with canonical pricing and signed evidence", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "en", id: "shop-telegram" };
    const identity = { customerId: "customer-telegram", subjectHash: "subject-telegram-quote" };
    const integrationId = "integration-telegram";
    const addKey = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, 105);
    const addContext = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "en", requestId: addKey, shopId: shop.id };
    const addApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: addKey, identity, integrationId, shop, updateId: 105 }));
    const cart = await addApplication.mutateCart(addContext, { cart: { access: { kind: "principal" }, cartId: null }, idempotencyKey: addKey, mutation: { kind: "item.increment", quantity: 1, variantId: "variant-telegram" } });
    const discountKey = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, 106);
    const context = { ...addContext, requestId: discountKey };
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: discountKey, identity, integrationId, shop, updateId: 106 }));
    await application.mutateCart(context, { cart: { access: { kind: "principal" }, cartId: null }, idempotencyKey: discountKey, mutation: { code: "WELCOME10", kind: "discount.apply" } });

    const quote = await application.quoteCart(context, { cart: cart.cart });

    expect(quote).toMatchObject({ currency: "VND", discountMinor: 100, subtotalMinor: 1000, totalMinor: 900 });
    expect(quote.items).toEqual([{ lineTotalMinor: 1000, productTitle: "Manual Product", quantity: 1, unitPriceMinor: 1000, variantId: "variant-telegram", variantTitle: "Default", variantVersion: 1 }]);
    expect(quote.quoteEvidence).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(runtime.database.database.prepare("SELECT locale FROM carts WHERE id = ? AND shop_id = ?").get(cart.cart.cartId, shop.id)).toEqual({ locale: "en" });
  });

  it("creates the first Telegram item through the canonical create operation and replays it", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const identity = { customerId: "customer-telegram", subjectHash: "subject-telegram-create" };
    const integrationId = "integration-telegram";
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, 107);
    const context = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity, integrationId, shop, updateId: 107 }));
    const command = { items: [{ quantity: 1, variantId: "variant-telegram" }] };

    const first = await application.createCart(context, command);
    const replay = await application.createCart(context, command);

    expect(first).toEqual(replay);
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ? AND variant_id = ?").get(first.cartId, shop.id, "variant-telegram")).toEqual({ quantity: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM telegram_actions WHERE shop_id = ? AND integration_id = ? AND update_id = ?").get(shop.id, integrationId, 107)).toEqual({ count: 1 });
  });

  it.each([
    ["UPDATE product_variants SET status = 'suspended' WHERE id = 'variant-telegram'", "catalog_changed"],
    ["UPDATE cart_items SET quantity = 6 WHERE variant_id = 'variant-telegram'", "quantity_unavailable"],
    ["UPDATE products SET fulfillment_type = 'license_key' WHERE id = 'product-telegram'", "inventory_unavailable"],
  ])("fails a stale Telegram quote through the shared projection: %s", async (sql, code) => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const identity = { customerId: "customer-telegram", subjectHash: `subject-${code}` };
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, "integration-telegram", 108);
    const context = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity, integrationId: "integration-telegram", shop, updateId: 108 }));
    const cart = await application.createCart(context, { items: [{ quantity: 1, variantId: "variant-telegram" }] });
    runtime.database.database.exec(sql);

    await expect(application.quoteCart(context, { cart: { access: { kind: "principal" }, cartId: cart.cartId } })).rejects.toMatchObject({ code, status: 409 });
  });

  it("denies a principal quote when the cart belongs to another Telegram identity", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const owner = { customerId: "customer-owner", subjectHash: "subject-owner" };
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, "integration-telegram", 109);
    const ownerContext = { actor: { customerId: owner.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const ownerApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity: owner, integrationId: "integration-telegram", shop, updateId: 109 }));
    const cart = await ownerApplication.createCart(ownerContext, { items: [{ quantity: 1, variantId: "variant-telegram" }] });
    const intruder = { customerId: "customer-intruder", subjectHash: "subject-intruder" };
    const intruderApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity: intruder, integrationId: "integration-telegram", shop, updateId: 109 }));

    await expect(intruderApplication.quoteCart({ ...ownerContext, actor: { customerId: intruder.customerId, kind: "customer" } }, { cart: { access: { kind: "principal" }, cartId: cart.cartId } })).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
  });

  it("does not replay a Telegram mutation action across principals", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const integrationId = "integration-telegram";
    const updateId = 110;
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, updateId);
    const owner = { customerId: "customer-owner", subjectHash: "subject-owner-replay" };
    const ownerContext = { actor: { customerId: owner.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const command = { cart: { access: { kind: "principal" as const }, cartId: null }, idempotencyKey: key, mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-telegram" } };
    const ownerApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity: owner, integrationId, shop, updateId }));
    const ownerCart = await ownerApplication.mutateCart(ownerContext, command);
    const intruder = { customerId: "customer-intruder", subjectHash: "subject-intruder-replay" };
    const intruderContext = { ...ownerContext, actor: { customerId: intruder.customerId, kind: "customer" as const } };
    const intruderApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity: intruder, integrationId, shop, updateId }));

    await expect(intruderApplication.mutateCart(intruderContext, command)).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM carts WHERE shop_id = ?").get(shop.id)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE shop_id = ? AND cart_id = ?").get(shop.id, ownerCart.cart.cartId)).toEqual({ quantity: 1 });
  });

  it("does not recover an expired Telegram create action as an active cart", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const identity = { customerId: "customer-expired", subjectHash: "subject-expired-create" };
    const integrationId = "integration-telegram";
    const updateId = 111;
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, updateId);
    const context = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity, integrationId, shop, updateId }));
    const command = { items: [{ quantity: 1, variantId: "variant-telegram" }] };
    const cart = await application.createCart(context, command);
    runtime.database.database.prepare("UPDATE carts SET expires_at = ? WHERE id = ? AND shop_id = ?").run("2000-01-01T00:00:00.000Z", cart.cartId, shop.id);

    await expect(application.createCart(context, command)).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM carts WHERE shop_id = ?").get(shop.id)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM telegram_actions WHERE shop_id = ? AND update_id = ?").get(shop.id, updateId)).toEqual({ count: 1 });
  });

  it("does not replay a mutation action after its Telegram cart expires", async () => {
    const runtime = createRuntime();
    const shop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram" };
    const identity = { customerId: "customer-expired-mutation", subjectHash: "subject-expired-mutation" };
    const integrationId = "integration-telegram";
    const updateId = 112;
    const key = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, integrationId, updateId);
    const context = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: null }, locale: "vi", requestId: key, shopId: shop.id };
    const application = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity, integrationId, shop, updateId }));
    const command = { cart: { access: { kind: "principal" as const }, cartId: null }, idempotencyKey: key, mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-telegram" } };
    const cart = await application.mutateCart(context, command);
    runtime.database.database.prepare("UPDATE carts SET expires_at = ? WHERE id = ? AND shop_id = ?").run("2000-01-01T00:00:00.000Z", cart.cart.cartId, shop.id);

    await expect(application.mutateCart(context, command)).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE shop_id = ? AND cart_id = ?").get(shop.id, cart.cart.cartId)).toEqual({ quantity: 1 });
  });
});
