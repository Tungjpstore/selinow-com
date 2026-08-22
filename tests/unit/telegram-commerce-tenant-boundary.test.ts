import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { handleTelegramCommerce, loadTelegramShop } from "../../src/lib/telegram/commerce";

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly mutations: string[],
  ) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    this.recordMutation();
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    this.recordMutation();
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    this.recordMutation();
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }

  private recordMutation(): void {
    if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(this.sql)) this.mutations.push(this.sql);
  }
}

class SqliteD1 {
  readonly mutations: string[] = [];

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, this.mutations);
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
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 31)
    .sort()) {
    sqlite.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-telegram-boundary', 'telegram-boundary', 'Telegram Boundary', '{"telegram":true}', '{}', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      canonical_domain_id, readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', 'shop-public-a', 'tenant-a', 'Tenant A', 'active', 'vi', 'VND',
        'Asia/Ho_Chi_Minh', 'domain-a', 1, '${NOW}', '${NOW}'),
      ('shop-b', 'shop-public-b', 'tenant-b', 'Tenant B', 'active', 'vi', 'VND',
        'Asia/Ho_Chi_Minh', 'domain-b', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_settings (
      shop_id, branding_json, storefront_json, order_expiry_minutes,
      low_stock_threshold, version, updated_at
    ) VALUES
      ('shop-a', '{}', '{}', 30, 5, 1, '${NOW}'),
      ('shop-b', '{}', '{}', 30, 5, 1, '${NOW}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at)
    VALUES
      ('subscription-a', 'shop-a', 'plan-telegram-boundary', 'active', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}'),
      ('subscription-b', 'shop-b', 'plan-telegram-boundary', 'active', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}');
    INSERT INTO shop_domains (
      id, shop_id, hostname_normalized, type, status, is_primary,
      validation_metadata_json, dns_status, version, activated_at, created_at, updated_at
    ) VALUES
      ('domain-a', 'shop-a', 'tenant-a.example.test', 'platform_subdomain', 'active', 1,
        '{}', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('domain-b', 'shop-b', 'tenant-b.example.test', 'platform_subdomain', 'active', 1,
        '{}', 'active', 1, '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status, created_at, updated_at
    ) VALUES (
      'integration-a', 'integration-public-a', 'integration-webhook-a', 'shop-a',
      'active', 'verified', '${NOW}', '${NOW}'
    );
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES
      ('product-a', 'shop-a', 'product-a', 'Product A', '', 'active', 'manual',
        1, '${NOW}', '${NOW}'),
      ('product-b', 'shop-b', 'product-b', 'Product B', '', 'active', 'manual',
        1, '${NOW}', '${NOW}');
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES
      ('variant-a-vnd', 'shop-a', 'product-a', 'VARIANT-A-VND', 'VND', '{}', 1000,
        'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-a-usd', 'shop-a', 'product-a', 'VARIANT-A-USD', 'USD mismatch', '{}', 999,
        'USD', 1, 5, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-b', 'shop-b', 'product-b', 'VARIANT-B', 'Default', '{}', 1000,
        'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}');
  `);
  sqlite.exec(readFileSync("migrations/0032_shop_globalization_invariants.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0045_telegram_customer_locale_preference.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0069_catalog_channel_visibility.sql", "utf8"));
  // Cart variant loads join physical stock (products.delivery_mode, TV3).
  sqlite.exec(readFileSync("migrations/0102_physical_goods_vertical.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0107_storefront_template_completion.sql", "utf8"));
  const database = new SqliteD1(sqlite);
  const env = {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    CREDENTIAL_KEK_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    IDENTIFIER_HMAC_SECRET: "telegram-tenant-boundary-secret",
    PLATFORM_DB: database as unknown as D1Database,
  } as unknown as AppBindings;
  return { database, env };
}

function callbackUpdate(input: { data: string; updateId: number; userId?: number }) {
  const userId = input.userId ?? 42;
  return {
    callbackId: `callback-${String(input.updateId)}`,
    chat: { id: userId, type: "private" as const },
    data: input.data,
    kind: "callback_query" as const,
    messageId: input.updateId,
    updateId: input.updateId,
    user: { firstName: "Buyer", id: userId, isBot: false, languageCode: "en", lastName: null, username: `buyer${String(userId)}` },
  };
}

function checkoutCallback(result: Awaited<ReturnType<typeof handleTelegramCommerce>>): string {
  const callback = result.reply.keyboard?.flat().find((button) => button.callback_data.startsWith("buy:"))?.callback_data;
  if (callback === undefined) throw new Error("telegram_checkout_callback_missing");
  return callback;
}

function persistedQuoteAction(runtime: ReturnType<typeof createRuntime>, updateId: number): { actionKind: string; id: string; reference: { cartId: string; quoteEvidence: string; subjectHash: string } } {
  const rows = runtime.database.database.prepare(`
    SELECT id, action_kind AS actionKind, result_reference AS resultReference
    FROM telegram_actions
    WHERE shop_id = 'shop-a' AND integration_id = 'integration-a' AND update_id = ?
  `).all(updateId) as Array<{ actionKind: string; id: string; resultReference: string }>;
  for (const row of rows) {
    try {
      const reference = JSON.parse(row.resultReference) as Partial<{ cartId: string; quoteEvidence: string; subjectHash: string }>;
      if (typeof reference.cartId === "string" && typeof reference.quoteEvidence === "string" && typeof reference.subjectHash === "string") {
        return { actionKind: row.actionKind, id: row.id, reference: reference as { cartId: string; quoteEvidence: string; subjectHash: string } };
      }
    } catch {
      // Mutation and checkout action references are not quote JSON.
    }
  }
  throw new Error("telegram_quote_action_missing");
}

describe("Telegram commerce tenant boundary", () => {
  it("uses only fresh exact Turnstile admission for a custom canonical origin", async () => {
    const runtime = createRuntime();
    const checkedAt = new Date().toISOString();
    runtime.database.database.prepare(`
      UPDATE shop_domains
      SET type = 'custom', hostname_normalized = 'shop.customer.example',
        ownership_verified_at = ?, hostname_status = 'active', ssl_status = 'active',
        dns_status = 'active', validation_metadata_json = ?
      WHERE id = 'domain-a' AND shop_id = 'shop-a'
    `).run(checkedAt, JSON.stringify({ turnstile: { checkedAt, hostname: "shop.customer.example", mode: "operator_managed", source: "cloudflare_widget_domains", status: "active" } }));

    await expect(loadTelegramShop(runtime.env, "shop-a")).resolves.toMatchObject({
      origin: "https://shop.customer.example",
    });

    runtime.database.database.prepare(`
      UPDATE shop_domains
      SET validation_metadata_json = ?
      WHERE id = 'domain-a' AND shop_id = 'shop-a'
    `).run(JSON.stringify({ turnstile: { checkedAt: "2020-01-01T00:00:00.000Z", hostname: "shop.customer.example", mode: "operator_managed", source: "cloudflare_widget_domains", status: "active" } }));

    await expect(loadTelegramShop(runtime.env, "shop-a"))
      .rejects.toMatchObject({ code: "tenant_not_found", status: 404 });
  });

  it("allows a command only when its normalized capability projection is effective", async () => {
    const runtime = createRuntime();

    const result = await handleTelegramCommerce({
      env: runtime.env,
      integrationId: "integration-a",
      shopId: "shop-a",
      update: {
        chat: { id: 42, type: "private" },
        kind: "message",
        messageId: 90,
        text: "/products",
        updateId: 90,
        user: { firstName: "Buyer", id: 42, isBot: false, languageCode: "en", lastName: null, username: "buyer" },
      },
    });

    expect(result.resultCode).toBe("catalog_rendered");
    expect(result.reply.text).toContain("Products from Tenant A");
  });

  it.each([
    ["missing provider grant", "DELETE FROM channel_connection_grants WHERE shop_id = 'shop-a' AND capability_code = 'catalog.read'"],
    ["expired provider grant", `UPDATE channel_connection_grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE shop_id = 'shop-a' AND capability_code = 'catalog.read'`],
    ["plan denial", `UPDATE plans SET feature_flags_json = '{}' WHERE id = 'plan-telegram-boundary'`],
    ["inactive plan policy", "UPDATE plans SET is_active = 0 WHERE id = 'plan-telegram-boundary'"],
    ["disabled seller channel", `UPDATE shop_channels SET status = 'disabled', version = version + 1, updated_at = '${NOW}' WHERE shop_id = 'shop-a' AND channel_code = 'telegram'`],
  ])("fails closed before identity or commerce writes for %s", async (_case, projectionMutation) => {
    const runtime = createRuntime();
    runtime.database.database.prepare(projectionMutation).run();

    await expect(handleTelegramCommerce({
      env: runtime.env,
      integrationId: "integration-a",
      shopId: "shop-a",
      update: {
        chat: { id: 42, type: "private" },
        kind: "message",
        messageId: 91,
        text: "/products",
        updateId: 91,
        user: { firstName: "Buyer", id: 42, isBot: false, languageCode: "en", lastName: null, username: "buyer" },
      },
    })).rejects.toMatchObject({ code: "channel_capability_unavailable", status: 403 });

    expect(runtime.database.mutations).toEqual([]);
    expect(runtime.database.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM shop_customers WHERE shop_id = 'shop-a') AS customers,
        (SELECT COUNT(*) FROM customer_identities WHERE shop_id = 'shop-a') AS identities,
        (SELECT COUNT(*) FROM telegram_recipients WHERE shop_id = 'shop-a') AS recipients,
        (SELECT COUNT(*) FROM carts WHERE shop_id = 'shop-a') AS carts,
        (SELECT COUNT(*) FROM telegram_actions WHERE shop_id = 'shop-a') AS actions
    `).get()).toEqual({ actions: 0, carts: 0, customers: 0, identities: 0, recipients: 0 });
  });

  it("keeps a verified persisted identity locale when a later update omits language_code", async () => {
    const runtime = createRuntime();
    const update = (updateId: number, languageCode: string | null) => ({
      chat: { id: 42, type: "private" as const },
      kind: "message" as const,
      messageId: updateId,
      text: "/products",
      updateId,
      user: {
        firstName: "Buyer",
        id: 42,
        isBot: false,
        languageCode,
        lastName: null,
        username: "buyer",
      },
    });

    const first = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: update(98, "en-US") });
    const second = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: update(99, null) });

    expect(first.reply.text).toContain("Products from Tenant A");
    expect(second.reply.text).toContain("Products from Tenant A");
    const persisted = runtime.database.database.prepare(`
      SELECT customer_identities.language_code AS languageCode,
        customer_identities.verified_at AS verifiedAt,
        shop_customers.locale
      FROM customer_identities
      INNER JOIN shop_customers
        ON shop_customers.id = customer_identities.customer_id
        AND shop_customers.shop_id = customer_identities.shop_id
      WHERE customer_identities.shop_id = 'shop-a'
        AND customer_identities.provider = 'telegram'
    `).get() as { languageCode: string; locale: string; verifiedAt: string } | undefined;
    expect(persisted).toMatchObject({ languageCode: "en", locale: "en" });
    expect(Number.isNaN(Date.parse(persisted?.verifiedAt ?? ""))).toBe(false);
  });

  it("lets a buyer choose and persist Vietnamese independently of Telegram identity hints", async () => {
    const runtime = createRuntime();
    const result = await handleTelegramCommerce({
      env: runtime.env,
      integrationId: "integration-a",
      shopId: "shop-a",
      update: {
        chat: { id: 42, type: "private" },
        kind: "message",
        messageId: 120,
        text: "/language vi",
        updateId: 120,
        user: { firstName: "Buyer", id: 42, isBot: false, languageCode: "en-US", lastName: null, username: "buyer" },
      },
    });

    expect(result.resultCode).toBe("language_updated");
    expect(result.reply.text).toBe("Đã lưu lựa chọn ngôn ngữ: Tiếng Việt.");
    expect(runtime.database.database.prepare(`
      SELECT preferred_locale AS preferredLocale, locale
      FROM shop_customers
      WHERE shop_id = 'shop-a' AND id = ?
    `).get(result.identity.customerId)).toEqual({ locale: "vi-VN", preferredLocale: "vi-VN" });
  });

  it("gives persisted explicit preference precedence over verified identity and request language", async () => {
    const runtime = createRuntime();
    const chooseVietnamese = (updateId: number, text: string, languageCode: string | null) => handleTelegramCommerce({
      env: runtime.env,
      integrationId: "integration-a",
      shopId: "shop-a",
      update: {
        chat: { id: 42, type: "private" },
        kind: "message",
        messageId: updateId,
        text,
        updateId,
        user: { firstName: "Buyer", id: 42, isBot: false, languageCode, lastName: null, username: "buyer" },
      },
    });

    await chooseVietnamese(121, "/language vi", "en");
    const rendered = await chooseVietnamese(122, "/products", "en");
    expect(rendered.reply.text).toContain("Sản phẩm của Tenant A");

    const explicitEnglish = await chooseVietnamese(123, "/language en", "vi");
    expect(explicitEnglish.reply.text).toBe("Language preference saved: English.");
    const persisted = runtime.database.database.prepare("SELECT preferred_locale AS preferredLocale, locale FROM shop_customers WHERE shop_id = 'shop-a'").get();
    expect(persisted).toEqual({ locale: "en", preferredLocale: "en" });
  });

  it("keeps repeated language preference commands semantically idempotent", async () => {
    const runtime = createRuntime();
    const update = (updateId: number) => ({
      chat: { id: 42, type: "private" as const },
      kind: "message" as const,
      messageId: updateId,
      text: "/language vi",
      updateId,
      user: { firstName: "Buyer", id: 42, isBot: false, languageCode: "en", lastName: null, username: "buyer" },
    });

    const first = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: update(124) });
    const second = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: update(125) });

    expect(second.resultCode).toBe(first.resultCode);
    expect(second.reply).toEqual(first.reply);
    expect(runtime.database.database.prepare("SELECT preferred_locale AS preferredLocale, locale FROM shop_customers WHERE shop_id = 'shop-a'").get()).toEqual({ locale: "vi-VN", preferredLocale: "vi-VN" });
  });

  it("does not share the same Telegram user preference across shops", async () => {
    const runtime = createRuntime();
    const update = (shopId: string, integrationId: string, updateId: number, text: string) => handleTelegramCommerce({
      env: runtime.env,
      integrationId,
      shopId,
      update: {
        chat: { id: 42, type: "private" },
        kind: "message",
        messageId: updateId,
        text,
        updateId,
        user: { firstName: "Buyer", id: 42, isBot: false, languageCode: "en", lastName: null, username: "buyer" },
      },
    });

    runtime.database.database.prepare(`INSERT INTO telegram_integrations (id, public_id, webhook_public_id, shop_id, status, webhook_status, created_at, updated_at) VALUES ('integration-b', 'integration-public-b', 'integration-webhook-b', 'shop-b', 'active', 'verified', ?, ?)`).run(NOW, NOW);
    await update("shop-a", "integration-a", 126, "/language vi");
    await update("shop-b", "integration-b", 127, "/language en");

    expect(runtime.database.database.prepare("SELECT preferred_locale AS preferredLocale FROM shop_customers WHERE shop_id = 'shop-a'").get()).toEqual({ preferredLocale: "vi-VN" });
    expect(runtime.database.database.prepare("SELECT preferred_locale AS preferredLocale FROM shop_customers WHERE shop_id = 'shop-b'").get()).toEqual({ preferredLocale: "en" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM customer_identities WHERE provider = 'telegram' AND external_subject = (SELECT external_subject FROM customer_identities WHERE shop_id = 'shop-a' LIMIT 1)").get()).toEqual({ count: 1 });
  });

  it.each([["unsupported", "/language fr"], ["malformed", "/language en-US extra"]])("does not mutate explicit preference for %s locale input", async (_label, text) => {
    const runtime = createRuntime();
    const result = await handleTelegramCommerce({
      env: runtime.env,
      integrationId: "integration-a",
      shopId: "shop-a",
      update: {
        chat: { id: 42, type: "private" },
        kind: "message",
        messageId: 128,
        text,
        updateId: 128,
        user: { firstName: "Buyer", id: 42, isBot: false, languageCode: "en", lastName: null, username: "buyer" },
      },
    });

    expect(result.resultCode).toBe("language_invalid");
    expect(runtime.database.database.prepare("SELECT preferred_locale AS preferredLocale FROM shop_customers WHERE shop_id = 'shop-a'").get()).toEqual({ preferredLocale: null });
  });

  it("renders only variants matching the tenant's supported authoritative currency", async () => {
    const runtime = createRuntime();

    const result = await handleTelegramCommerce({
      env: runtime.env,
      integrationId: "integration-a",
      shopId: "shop-a",
      update: {
        chat: { id: 42, type: "private" },
        kind: "message",
        messageId: 7,
        text: "/products",
        updateId: 100,
        user: {
          firstName: "Buyer",
          id: 42,
          isBot: false,
          languageCode: "vi",
          lastName: null,
          username: "buyer",
        },
      },
    });

    expect(result.resultCode).toBe("catalog_rendered");
    expect(result.reply.text).toContain("Product A - VND");
    expect(result.reply.text).not.toContain("USD mismatch");
    expect(result.reply.keyboard?.flat().map((button) => button.callback_data)).toContain("add:variant-a-vnd");
    expect(result.reply.keyboard?.flat().map((button) => button.callback_data)).not.toContain("add:variant-a-usd");
  });

  it("renders a non-empty principal cart through the canonical quote application", async () => {
    const runtime = createRuntime();

    const result = await handleTelegramCommerce({
      env: runtime.env,
      integrationId: "integration-a",
      shopId: "shop-a",
      update: {
        callbackId: "callback-add-a",
        chat: { id: 42, type: "private" },
        data: "add:variant-a-vnd",
        kind: "callback_query",
        messageId: 8,
        updateId: 102,
        user: { firstName: "Buyer", id: 42, isBot: false, languageCode: "en", lastName: null, username: "buyer" },
      },
    });

    expect(result.resultCode).toBe("cart_updated");
    expect(result.reply.text).toContain("Cart for Tenant A");
    expect(result.reply.text).toContain("Product A - VND x1");
    expect(runtime.database.database.prepare("SELECT channel, locale, state FROM carts WHERE shop_id = 'shop-a'").get()).toEqual({ channel: "telegram", locale: "en", state: "active" });
  });

  it("persists an immutable Telegram quote action and checks out the unchanged displayed quote", async () => {
    const runtime = createRuntime();
    runtime.database.database.prepare("UPDATE product_variants SET price_minor = 0 WHERE id = 'variant-a-vnd' AND shop_id = 'shop-a'").run();
    const displayed = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: "add:variant-a-vnd", updateId: 103 }) });
    const buyCallback = checkoutCallback(displayed);

    expect(buyCallback).toBe("buy:103");
    expect(buyCallback.length).toBeLessThanOrEqual(64);
    expect(persistedQuoteAction(runtime, 103).reference.quoteEvidence).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    const completed = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: buyCallback, updateId: 104 }) });

    expect(completed.resultCode).toBe("checkout_completed");
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = 'shop-a'").get()).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = 'shop-a' AND status = 'reserved'").get()).toEqual({ count: 0 });
  });

  it.each([
    ["price", "UPDATE product_variants SET price_minor = price_minor + 1 WHERE id = 'variant-a-vnd' AND shop_id = 'shop-a'"],
    ["version", "UPDATE product_variants SET version = version + 1 WHERE id = 'variant-a-vnd' AND shop_id = 'shop-a'"],
  ])("rejects a Telegram checkout when the displayed quote's %s changes", async (_field, sql) => {
    const runtime = createRuntime();
    const displayed = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: "add:variant-a-vnd", updateId: 105 }) });
    const buyCallback = checkoutCallback(displayed);
    runtime.database.database.prepare(sql).run();

    const rejected = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: buyCallback, updateId: 106 }) });

    expect(rejected.resultCode).toBe("quote_invalid");
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = 'shop-a'").get()).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE shop_id = 'shop-a'").get()).toEqual({ state: "active" });
  });

  it("fails closed for a legacy bare buy callback instead of checking out at the current price", async () => {
    const runtime = createRuntime();
    const displayed = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: "add:variant-a-vnd", updateId: 107 }) });
    expect(checkoutCallback(displayed)).toBe("buy:107");

    const rejected = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: "buy", updateId: 108 }) });

    expect(rejected.resultCode).not.toBe("checkout_completed");
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = 'shop-a'").get()).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE shop_id = 'shop-a'").get()).toEqual({ state: "active" });
  });

  it("rejects a persisted Telegram quote callback replayed by another principal", async () => {
    const runtime = createRuntime();
    const displayed = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: "add:variant-a-vnd", updateId: 109 }) });
    const buyCallback = checkoutCallback(displayed);

    const rejected = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: buyCallback, updateId: 110, userId: 43 }) });

    expect(rejected.resultCode).toBe("quote_invalid");
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = 'shop-a'").get()).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE shop_id = 'shop-a'").get()).toEqual({ state: "active" });
  });

  it("rejects tampering with a persisted Telegram quote action before checkout", async () => {
    const runtime = createRuntime();
    const displayed = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: "add:variant-a-vnd", updateId: 111 }) });
    const buyCallback = checkoutCallback(displayed);
    const action = persistedQuoteAction(runtime, 111);
    const tamperedEvidence = `${action.reference.quoteEvidence.slice(0, -1)}${action.reference.quoteEvidence.endsWith("a") ? "b" : "a"}`;
    runtime.database.database.prepare("UPDATE telegram_actions SET result_reference = ? WHERE id = ? AND shop_id = 'shop-a'").run(JSON.stringify({ ...action.reference, quoteEvidence: tamperedEvidence }), action.id);

    const rejected = await handleTelegramCommerce({ env: runtime.env, integrationId: "integration-a", shopId: "shop-a", update: callbackUpdate({ data: buyCallback, updateId: 112 }) });

    expect(rejected.resultCode).toBe("quote_invalid");
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = 'shop-a'").get()).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE shop_id = 'shop-a'").get()).toEqual({ state: "active" });
  });

  it("rejects an integration from another shop before identity, recipient, cart, or action writes", async () => {
    const runtime = createRuntime();

    await expect(handleTelegramCommerce({
      env: runtime.env,
      integrationId: "integration-a",
      shopId: "shop-b",
      update: {
        callbackId: "callback-cross-tenant",
        chat: { id: 42, type: "private" },
        data: "add:variant-b",
        kind: "callback_query",
        messageId: 7,
        updateId: 101,
        user: {
          firstName: "Buyer",
          id: 42,
          isBot: false,
          languageCode: "vi",
          lastName: null,
          username: "buyer",
        },
      },
    })).rejects.toMatchObject({ code: "telegram_not_configured", status: 409 });

    expect(runtime.database.mutations).toEqual([]);
    expect(runtime.database.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM shop_customers WHERE shop_id = 'shop-b') AS customers,
        (SELECT COUNT(*) FROM customer_identities WHERE shop_id = 'shop-b') AS identities,
        (SELECT COUNT(*) FROM telegram_recipients WHERE shop_id = 'shop-b') AS recipients,
        (SELECT COUNT(*) FROM carts WHERE shop_id = 'shop-b') AS carts,
        (SELECT COUNT(*) FROM telegram_actions WHERE shop_id = 'shop-b') AS actions
    `).get()).toEqual({ actions: 0, carts: 0, customers: 0, identities: 0, recipients: 0 });
  });
});
