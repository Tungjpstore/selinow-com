import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { CommerceApplicationService } from "../../src/lib/commerce/application";
import {
  createTelegramCartMutationApplicationKey,
  persistTelegramQuoteAction,
  TelegramCartMutationPort,
} from "../../src/lib/commerce/telegram-port";
import { checkoutTelegramCart, type TelegramIdentity, type TelegramShop } from "../../src/lib/telegram/commerce";
import { connectTelegram, disconnectTelegram, refreshTelegramHealth } from "../../src/lib/telegram/integrations";

vi.mock("../../src/lib/tenants/store", () => ({
  getShopForMember: vi.fn(() => Promise.resolve({
    row: { role: "owner", shop_id: "shop-telegram-runtime" },
    shop: { defaultLocale: "vi-VN" },
  })),
}));

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
const NOW = "2026-07-27T00:00:00.000Z";
const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDE";
const ROTATED_BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde";
const TELEGRAM_CAPABILITIES = [
  "cart.interactive",
  "catalog.read",
  "checkout.external_link",
  "conversation.inbound",
  "conversation.outbound",
  "fulfillment.inline_secret",
  "identity.private",
  "message.rich_ui",
];

it("keeps Telegram grant sources within D1's compound SELECT limit", () => {
  const migration = readFileSync(
    join(process.cwd(), "migrations", "0027_telegram_generic_connection_link.sql"),
    "utf8",
  );
  const sources = [...migration.matchAll(
    /(?:CROSS JOIN|FROM)\s*\(\s*(SELECT\s+'[^']+'\s+AS capability_code(?:\s+UNION ALL SELECT\s+'[^']+')*)\s*\)\s+AS capabilities/gu,
  )].map((match) => match[1]).filter((source): source is string => source !== undefined);

  expect(sources).toHaveLength(4);
  for (const source of sources) {
    expect(source.match(/\bSELECT\b/gu)).toHaveLength(4);
  }
  for (const pair of [sources.slice(0, 2), sources.slice(2, 4)]) {
    const capabilities = pair.flatMap((source) => [...source.matchAll(/'([^']+)'/gu)].map((match) => match[1])).sort();
    expect(capabilities).toEqual(TELEGRAM_CAPABILITIES);
  }
});

function createRuntime(): {
  commandPayloads(): Array<{ commands: Array<{ command: string; description: string }>; language_code?: string }>;
  webhookPayloads(): Array<Record<string, unknown>>;
  deleteWebhookPayloads(): Array<Record<string, unknown>>;
  database: SqliteD1;
  env: AppBindings;
  fetcher: typeof fetch;
  setDeliveryError(value: boolean): void;
  setWebhookFailure(value: boolean): void;
} {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    sqlite.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-telegram-runtime', 'telegram-runtime@example.test', 'Owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (
      'shop-telegram-runtime', 'shop-public-telegram-runtime', 'telegram-runtime',
      'Telegram Runtime', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'
    );
  `);
  const database = new SqliteD1(sqlite);
  let deliveryError = false;
  let webhookFailure = false;
  const commandPayloads: Array<{ commands: Array<{ command: string; description: string }>; language_code?: string }> = [];
  const webhookPayloads: Array<Record<string, unknown>> = [];
  const deleteWebhookPayloads: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = (request, init) => {
    const url = request instanceof Request ? request.url : request.toString();
    const method = url.slice(url.lastIndexOf("/") + 1);
    if (method === "setMyCommands" && typeof init?.body === "string") {
      commandPayloads.push(JSON.parse(init.body) as { commands: Array<{ command: string; description: string }>; language_code?: string });
    }
    if (method === "setWebhook" && typeof init?.body === "string") webhookPayloads.push(JSON.parse(init.body) as Record<string, unknown>);
    if (method === "deleteWebhook" && typeof init?.body === "string") deleteWebhookPayloads.push(JSON.parse(init.body) as Record<string, unknown>);
    if (method === "setWebhook" && webhookFailure) {
      return Promise.resolve(new Response(JSON.stringify({ description: "provider detail", ok: false }), { status: 400 }));
    }
  const result: Record<string, unknown> | boolean = method === "getMe"
      ? { first_name: "Runtime Bot", id: 123_456_789, is_bot: true, username: "runtime_bot" }
      : method === "getWebhookInfo"
        ? {
            allowed_updates: ["message", "callback_query"],
            max_connections: 20,
            ...(deliveryError ? { last_error_message: "provider detail" } : {}),
            pending_update_count: 0,
            url: "https://api.test/webhooks/telegram/telegram-webhook-placeholder",
          }
        : true;
    if (method === "getWebhookInfo") {
      const webhook = sqlite.prepare("SELECT webhook_public_id AS webhookPublicId FROM telegram_integrations LIMIT 1").get() as { webhookPublicId?: string } | undefined;
      if (webhook?.webhookPublicId !== undefined && typeof result === "object") result.url = `https://api.test/webhooks/telegram/${webhook.webhookPublicId}`;
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
  };
  const env = {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    API_ORIGIN: "https://api.test",
    CREDENTIAL_KEK_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    CREDENTIAL_KEY_VERSION: "v1",
    IDENTIFIER_HMAC_SECRET: "telegram-runtime-identifier-secret",
    PLATFORM_DB: database as unknown as D1Database,
    TELEGRAM_WEBHOOK_MAX_CONNECTIONS: "20",
  } as unknown as AppBindings;
  return {
    commandPayloads: () => commandPayloads,
    deleteWebhookPayloads: () => deleteWebhookPayloads,
    database,
    env,
    fetcher,
    webhookPayloads: () => webhookPayloads,
    setDeliveryError: (value) => { deliveryError = value; },
    setWebhookFailure: (value) => { webhookFailure = value; },
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function connect(runtime: ReturnType<typeof createRuntime>, requestId: string) {
  return connectTelegram({
    botToken: BOT_TOKEN,
    env: runtime.env,
    fetcher: runtime.fetcher,
    replaceBot: false,
    requestId,
    shopPublicId: "shop-public-telegram-runtime",
    userId: "user-telegram-runtime",
  });
}

describe("Telegram generic connection runtime bridge", () => {
  it("revokes the old credential and rejects pending updates across rotation and disconnect", async () => {
    const runtime = createRuntime();
    await connect(runtime, "telegram-generation-connect");
    const integration = runtime.database.database.prepare("SELECT id FROM telegram_integrations").get() as { id: string };
    runtime.database.database.prepare(`
      INSERT INTO telegram_updates (
        id, shop_id, integration_id, update_id, payload_hash, update_kind,
        status, attempts, received_at, updated_at
      ) VALUES (?, 'shop-telegram-runtime', ?, ?, ?, 'message', ?, 1, ?, ?)
    `).run("update-rotation-pending", integration.id, 501, "hash-501", "processing", NOW, NOW);

    await connectTelegram({
      botToken: ROTATED_BOT_TOKEN,
      env: runtime.env,
      fetcher: runtime.fetcher,
      replaceBot: false,
      requestId: "telegram-generation-rotate",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    });

    expect(runtime.webhookPayloads().at(-1)).toMatchObject({ drop_pending_updates: true });

    expect(runtime.database.database.prepare("SELECT status, safe_result_code AS resultCode FROM telegram_updates WHERE id = 'update-rotation-pending'").get()).toEqual({ resultCode: "telegram_update_stale_generation", status: "rejected" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM telegram_credentials WHERE integration_id = ? AND status = 'revoked'").get(integration.id)).toEqual({ count: 1 });

    runtime.database.database.prepare(`
      INSERT INTO telegram_updates (
        id, shop_id, integration_id, update_id, payload_hash, update_kind,
        status, attempts, received_at, updated_at
      ) VALUES (?, 'shop-telegram-runtime', ?, ?, ?, 'message', 'failed', 1, ?, ?)
    `).run("update-disconnect-pending", integration.id, 502, "hash-502", NOW, NOW);
    await disconnectTelegram({ env: runtime.env, fetcher: runtime.fetcher, requestId: "telegram-generation-disconnect", shopPublicId: "shop-public-telegram-runtime", userId: "user-telegram-runtime" });

    expect(runtime.database.database.prepare("SELECT status, safe_result_code AS resultCode FROM telegram_updates WHERE id = 'update-disconnect-pending'").get()).toEqual({ resultCode: "telegram_update_stale_generation", status: "rejected" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE resource_id = ? AND action = 'telegram.update_generation_fenced'").get(integration.id)).toEqual({ count: 2 });
    expect(runtime.deleteWebhookPayloads().at(-1)).toEqual({ drop_pending_updates: true });
  });

  it("registers the shop locale as default with explicit English and Vietnamese scopes", async () => {
    const runtime = createRuntime();

    await expect(connect(runtime, "telegram-command-locales")).resolves.toMatchObject({ status: "active" });

    const [defaultPayload, englishPayload, vietnamesePayload] = runtime.commandPayloads();
    expect(runtime.commandPayloads()).toHaveLength(3);
    expect(defaultPayload?.commands).toContainEqual({ command: "start", description: "Mở menu cửa hàng" });
    expect(defaultPayload?.language_code).toBeUndefined();
    expect(englishPayload?.commands).toContainEqual({ command: "start", description: "Open the shop menu" });
    expect(englishPayload?.language_code).toBe("en");
    expect(vietnamesePayload?.commands).toContainEqual({ command: "start", description: "Mở menu cửa hàng" });
    expect(vietnamesePayload?.language_code).toBe("vi");
  });

  it("creates grants, attributes orders, and preserves disconnected evidence across reconnect", async () => {
    const runtime = createRuntime();
    await expect(connect(runtime, "telegram-connect-1")).resolves.toMatchObject({ status: "active" });
    const first = runtime.database.database.prepare(`
      SELECT telegram_integrations.id AS integrationId,
        telegram_integrations.channel_connection_id AS connectionId,
        channel_connections.status, shop_channels.status AS channelStatus
      FROM telegram_integrations
      INNER JOIN channel_connections ON channel_connections.id = telegram_integrations.channel_connection_id
      INNER JOIN shop_channels ON shop_channels.id = channel_connections.shop_channel_id
    `).get() as { channelStatus: string; connectionId: string; integrationId: string; status: string };
    expect(first).toMatchObject({ channelStatus: "enabled", status: "active" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM channel_connection_grants WHERE connection_id = ?").get(first.connectionId)).toEqual({ count: 8 });

    runtime.database.database.exec(`
      INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
      VALUES ('product-telegram-runtime', 'shop-telegram-runtime', 'runtime-product', 'Runtime Product', '', 'active', 'manual', 1, '${NOW}', '${NOW}');
      INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
      VALUES ('variant-telegram-runtime', 'shop-telegram-runtime', 'product-telegram-runtime', 'TG-RUNTIME', 'Default', '{}', 1000, 'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}');
      INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
      VALUES ('customer-telegram-runtime', 'shop-telegram-runtime', NULL, 'Customer', 'vi', 'active', '${NOW}', '${NOW}');
      INSERT INTO carts (id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at)
      VALUES ('cart-telegram-runtime', 'shop-telegram-runtime', 'telegram', 'subject-telegram-runtime', 'vi', 'active', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}');
      INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity)
      VALUES ('cart-telegram-runtime', 'shop-telegram-runtime', 'variant-telegram-runtime', 1);
    `);
    const identity: TelegramIdentity = { chatId: "123", customerId: "customer-telegram-runtime", identityId: "identity-runtime", subjectHash: "subject-telegram-runtime" };
    const shop: TelegramShop = { currency: "VND", defaultLocale: "vi", id: "shop-telegram-runtime", name: "Runtime", orderExpiryMinutes: 30, origin: "https://runtime.selinow.com", status: "active", subscriptionState: "active" };
    const quoteUpdateId = 1;
    const quoteKey = await createTelegramCartMutationApplicationKey(runtime.env, shop.id, first.integrationId, quoteUpdateId);
    const quoteContext = { actor: { customerId: identity.customerId, kind: "customer" as const }, channel: { code: "telegram" as const, connectionId: first.connectionId }, locale: shop.defaultLocale, requestId: quoteKey, shopId: shop.id };
    const quoteApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: first.connectionId, env: runtime.env, expectedIdempotencyKey: quoteKey, identity: { customerId: identity.customerId, subjectHash: identity.subjectHash }, integrationId: first.integrationId, shop, updateId: quoteUpdateId }));
    const quote = await quoteApplication.quoteCart(quoteContext, { cart: { access: { kind: "principal" }, cartId: "cart-telegram-runtime" } });
    await persistTelegramQuoteAction({ cartId: "cart-telegram-runtime", discountCode: null, env: runtime.env, identity: { customerId: identity.customerId, subjectHash: identity.subjectHash }, integrationId: first.integrationId, quote, shop, updateId: quoteUpdateId });
    const order = await checkoutTelegramCart({ env: runtime.env, identity, integrationId: first.integrationId, quoteUpdateId, shop, updateId: 2 });
    expect(runtime.database.database.prepare(`
      SELECT order_channel_attributions.connection_id AS connectionId
      FROM order_channel_attributions
      INNER JOIN orders ON orders.id = order_channel_attributions.order_id
      WHERE orders.public_id = ?
    `).get(order.orderId)).toEqual({ connectionId: first.connectionId });

    await disconnectTelegram({ env: runtime.env, fetcher: runtime.fetcher, requestId: "telegram-disconnect", shopPublicId: "shop-public-telegram-runtime", userId: "user-telegram-runtime" });
    expect(runtime.database.database.prepare("SELECT status FROM channel_connections WHERE id = ?").get(first.connectionId)).toEqual({ status: "disconnected" });
    await expect(connect(runtime, "telegram-connect-2")).resolves.toMatchObject({ status: "active" });
    const second = runtime.database.database.prepare("SELECT channel_connection_id AS connectionId FROM telegram_integrations").get() as { connectionId: string };
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(runtime.database.database.prepare("SELECT status FROM channel_connections WHERE id = ?").get(first.connectionId)).toEqual({ status: "disconnected" });
  });

  it("keeps setup errors pending and mirrors health degradation and recovery", async () => {
    const runtime = createRuntime();
    runtime.setWebhookFailure(true);
    await expect(connect(runtime, "telegram-connect-error")).rejects.toBeTruthy();
    expect(runtime.database.database.prepare(`
      SELECT channel_connections.status, channel_connections.last_safe_error_code AS errorCode,
        shop_channels.status AS channelStatus
      FROM telegram_integrations
      INNER JOIN channel_connections ON channel_connections.id = telegram_integrations.channel_connection_id
      INNER JOIN shop_channels ON shop_channels.id = channel_connections.shop_channel_id
    `).get()).toMatchObject({ channelStatus: "pending", status: "pending" });

    runtime.setWebhookFailure(false);
    await expect(refreshTelegramHealth({ env: runtime.env, fetcher: runtime.fetcher, requestId: "telegram-retry", shopPublicId: "shop-public-telegram-runtime", userId: "user-telegram-runtime" })).resolves.toMatchObject({ status: "active" });
    runtime.setDeliveryError(true);
    await expect(refreshTelegramHealth({ env: runtime.env, fetcher: runtime.fetcher, requestId: "telegram-degraded", shopPublicId: "shop-public-telegram-runtime", userId: "user-telegram-runtime" })).resolves.toMatchObject({ status: "degraded" });
    expect(runtime.database.database.prepare("SELECT status FROM channel_connections WHERE id = (SELECT channel_connection_id FROM telegram_integrations)").get()).toEqual({ status: "degraded" });
    runtime.setDeliveryError(false);
    await expect(refreshTelegramHealth({ env: runtime.env, fetcher: runtime.fetcher, requestId: "telegram-recovered", shopPublicId: "shop-public-telegram-runtime", userId: "user-telegram-runtime" })).resolves.toMatchObject({ status: "active" });
  });
});
