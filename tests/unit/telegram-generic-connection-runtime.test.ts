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
  getShopForMember: vi.fn((input: { shopPublicId: string }) => Promise.resolve(input.shopPublicId === "shop-public-telegram-reclaim"
      ? {
        row: { role: "owner", shop_id: "shop-telegram-reclaim", shop_status: "active" },
        shop: { defaultLocale: "en", featureFlags: { telegram: true } },
      }
    : {
        row: { role: "owner", shop_id: "shop-telegram-runtime", shop_status: "active" },
        shop: { defaultLocale: "vi-VN", featureFlags: { telegram: true } },
      })),
}));

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly beforeFirst?: () => void,
  ) {}

  get sqlText(): string {
    return this.sql;
  }

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    this.beforeFirst?.();
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
  private batchFailureFragment: string | null = null;
  private batchResponseLossFragment: string | null = null;
  private firstFailureFragment: string | null = null;

  constructor(readonly database: DatabaseSync) {}

  failNextBatchOn(fragment: string): void {
    this.batchFailureFragment = fragment;
  }

  failNextFirstOn(fragment: string): void {
    this.firstFailureFragment = fragment;
  }

  loseNextBatchResponseAfterCommitOn(fragment: string): void {
    this.batchResponseLossFragment = fragment;
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, () => {
      if (this.firstFailureFragment !== null && sql.includes(this.firstFailureFragment)) {
        this.firstFailureFragment = null;
        throw new Error("injected_authority_read_failure");
      }
    });
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    if (this.batchFailureFragment !== null
      && statements.some((statement) => statement.sqlText.includes(this.batchFailureFragment ?? ""))) {
      this.batchFailureFragment = null;
      throw new Error("injected_activation_batch_failure");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      if (this.batchResponseLossFragment !== null
        && statements.some((statement) => statement.sqlText.includes(this.batchResponseLossFragment ?? ""))) {
        this.batchResponseLossFragment = null;
        throw new Error("injected_activation_batch_response_loss");
      }
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const databases: DatabaseSync[] = [];
const NOW = "2026-07-27T00:00:00.000Z";
const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDE";
const ROTATED_BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde";
const REPLACEMENT_OLD_BOT_TOKEN = "111111111:oldBotTokenabcdefghijklmnopqrstuvwxyz";
const REPLACEMENT_NEW_BOT_TOKEN = "222222222:newBotTokenabcdefghijklmnopqrstuvwxyz";
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
  it("restores the old webhook after an ambiguous delete timeout while old ownership remains authoritative", async () => {
    const runtime = createRuntime();
    const webhookByToken = new Map<string, string | null>();
    let loseOldDeleteResponse = false;
    const fetcher: typeof fetch = (request, init) => {
      const url = request instanceof Request ? request.url : request.toString();
      const token = url.includes(REPLACEMENT_OLD_BOT_TOKEN)
        ? REPLACEMENT_OLD_BOT_TOKEN
        : REPLACEMENT_NEW_BOT_TOKEN;
      const method = url.slice(url.lastIndexOf("/") + 1);
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      if (method === "setWebhook") webhookByToken.set(token, String(body.url));
      if (method === "deleteWebhook") {
        webhookByToken.set(token, null);
        if (loseOldDeleteResponse && token === REPLACEMENT_OLD_BOT_TOKEN) {
          loseOldDeleteResponse = false;
          return Promise.reject(new Error("injected_delete_response_loss"));
        }
      }
      const botId = token === REPLACEMENT_OLD_BOT_TOKEN ? 111_111_111 : 222_222_222;
      const botIdText = String(botId);
      const result: Record<string, unknown> | boolean = method === "getMe"
        ? { first_name: `Bot ${botIdText}`, id: botId, is_bot: true, username: `bot_${botIdText}_bot` }
        : method === "getWebhookInfo"
          ? {
              allowed_updates: ["message", "callback_query"],
              max_connections: 20,
              pending_update_count: 0,
              url: webhookByToken.get(token) ?? "",
            }
          : true;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
    };

    const original = await connectTelegram({
      botToken: REPLACEMENT_OLD_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: false,
      requestId: "telegram-delete-timeout-old-connect",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    });
    loseOldDeleteResponse = true;

    await expect(connectTelegram({
      botToken: REPLACEMENT_NEW_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: true,
      requestId: "telegram-delete-timeout-new-replace",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    })).rejects.toMatchObject({ code: "telegram_webhook_failed" });

    const integration = runtime.database.database.prepare(`
      SELECT active_credential_id AS activeCredentialId, bot_id AS botId,
        webhook_public_id AS webhookPublicId
      FROM telegram_integrations WHERE shop_id = 'shop-telegram-runtime'
    `).get() as { activeCredentialId: string; botId: string; webhookPublicId: string };
    expect(integration.botId).toBe(original.bot?.id);
    expect(integration.activeCredentialId).not.toBeNull();
    expect(webhookByToken.get(REPLACEMENT_OLD_BOT_TOKEN))
      .toBe(`https://api.test/webhooks/telegram/${integration.webhookPublicId}`);
    expect(webhookByToken.get(REPLACEMENT_NEW_BOT_TOKEN)).toBeNull();
  });

  it("does not let delayed old-bot cleanup delete a concurrently reclaimed tenant webhook", async () => {
    const runtime = createRuntime();
    runtime.database.database.exec(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('user-telegram-reclaim', 'telegram-reclaim@example.test', 'Reclaim owner', 'active', '${NOW}', '${NOW}');
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES (
        'shop-telegram-reclaim', 'shop-public-telegram-reclaim', 'telegram-reclaim',
        'Telegram Reclaim', 'active', 'en', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'
      );
    `);
    const webhookByToken = new Map<string, string | null>();
    let raceEnabled = false;
    let raceResult: unknown = null;
    const fetcher: typeof fetch = async (request, init) => {
      const url = request instanceof Request ? request.url : request.toString();
      const token = url.includes(REPLACEMENT_OLD_BOT_TOKEN)
        ? REPLACEMENT_OLD_BOT_TOKEN
        : REPLACEMENT_NEW_BOT_TOKEN;
      const method = url.slice(url.lastIndexOf("/") + 1);
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      if (method === "setWebhook") webhookByToken.set(token, String(body.url));
      if (method === "deleteWebhook") {
        if (raceEnabled && token === REPLACEMENT_OLD_BOT_TOKEN && raceResult === null) {
          try {
            raceResult = await connectTelegram({
              botToken: REPLACEMENT_OLD_BOT_TOKEN,
              env: runtime.env,
              fetcher,
              replaceBot: false,
              requestId: "telegram-reclaim-during-cleanup",
              shopPublicId: "shop-public-telegram-reclaim",
              userId: "user-telegram-reclaim",
            });
          } catch (error) {
            raceResult = error;
          }
        }
        webhookByToken.set(token, null);
      }
      const botId = token === REPLACEMENT_OLD_BOT_TOKEN ? 111_111_111 : 222_222_222;
      const botIdText = String(botId);
      const result: Record<string, unknown> | boolean = method === "getMe"
        ? { first_name: `Bot ${botIdText}`, id: botId, is_bot: true, username: `bot_${botIdText}_bot` }
        : method === "getWebhookInfo"
          ? {
              allowed_updates: ["message", "callback_query"],
              max_connections: 20,
              pending_update_count: 0,
              url: webhookByToken.get(token) ?? "",
            }
          : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    };

    await connectTelegram({
      botToken: REPLACEMENT_OLD_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: false,
      requestId: "telegram-old-bot-connect",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    });
    raceEnabled = true;
    await connectTelegram({
      botToken: REPLACEMENT_NEW_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: true,
      requestId: "telegram-new-bot-replace",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    });

    expect(raceResult).toMatchObject({ code: "telegram_bot_already_connected" });
    await expect(connectTelegram({
      botToken: REPLACEMENT_OLD_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: false,
      requestId: "telegram-old-bot-reclaim-retry",
      shopPublicId: "shop-public-telegram-reclaim",
      userId: "user-telegram-reclaim",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    const reclaimed = runtime.database.database.prepare(`
      SELECT webhook_public_id AS webhookPublicId
      FROM telegram_integrations WHERE shop_id = 'shop-telegram-reclaim'
    `).get() as { webhookPublicId: string };
    expect(webhookByToken.get(REPLACEMENT_OLD_BOT_TOKEN))
      .toBe(`https://api.test/webhooks/telegram/${reclaimed.webhookPublicId}`);
  });

  it("restores the owned old-bot webhook when replacement activation fails after cleanup", async () => {
    const runtime = createRuntime();
    const webhookByToken = new Map<string, string | null>();
    let injectActivationFailure = false;
    const fetcher: typeof fetch = (request, init) => {
      const url = request instanceof Request ? request.url : request.toString();
      const token = url.includes(REPLACEMENT_OLD_BOT_TOKEN)
        ? REPLACEMENT_OLD_BOT_TOKEN
        : REPLACEMENT_NEW_BOT_TOKEN;
      const method = url.slice(url.lastIndexOf("/") + 1);
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      if (method === "setWebhook") webhookByToken.set(token, String(body.url));
      if (method === "deleteWebhook") {
        webhookByToken.set(token, null);
        if (injectActivationFailure && token === REPLACEMENT_OLD_BOT_TOKEN) {
          injectActivationFailure = false;
          runtime.database.failNextBatchOn("UPDATE telegram_credentials SET status = 'revoked'");
        }
      }
      const botId = token === REPLACEMENT_OLD_BOT_TOKEN ? 111_111_111 : 222_222_222;
      const botIdText = String(botId);
      const result: Record<string, unknown> | boolean = method === "getMe"
        ? { first_name: `Bot ${botIdText}`, id: botId, is_bot: true, username: `bot_${botIdText}_bot` }
        : method === "getWebhookInfo"
          ? {
              allowed_updates: ["message", "callback_query"],
              max_connections: 20,
              pending_update_count: 0,
              url: webhookByToken.get(token) ?? "",
            }
          : true;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
    };

    const original = await connectTelegram({
      botToken: REPLACEMENT_OLD_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: false,
      requestId: "telegram-rollback-old-connect",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    });
    injectActivationFailure = true;
    await expect(connectTelegram({
      botToken: REPLACEMENT_NEW_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: true,
      requestId: "telegram-rollback-new-replace",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    })).rejects.toMatchObject({ code: "telegram_activation_failed" });

    const integration = runtime.database.database.prepare(`
      SELECT active_credential_id AS activeCredentialId, bot_id AS botId,
        webhook_public_id AS webhookPublicId
      FROM telegram_integrations WHERE shop_id = 'shop-telegram-runtime'
    `).get() as { activeCredentialId: string; botId: string; webhookPublicId: string };
    expect(integration.botId).toBe(original.bot?.id);
    expect(integration.activeCredentialId).not.toBeNull();
    expect(webhookByToken.get(REPLACEMENT_OLD_BOT_TOKEN))
      .toBe(`https://api.test/webhooks/telegram/${integration.webhookPublicId}`);
    expect(webhookByToken.get(REPLACEMENT_NEW_BOT_TOKEN)).toBeNull();
  });

  it("fails non-destructively and degrades the old generation when activation authority cannot be read", async () => {
    const runtime = createRuntime();
    const webhookByToken = new Map<string, string | null>();
    let injectActivationFailure = false;
    const fetcher: typeof fetch = (request, init) => {
      const url = request instanceof Request ? request.url : request.toString();
      const token = url.includes(REPLACEMENT_OLD_BOT_TOKEN)
        ? REPLACEMENT_OLD_BOT_TOKEN
        : REPLACEMENT_NEW_BOT_TOKEN;
      const method = url.slice(url.lastIndexOf("/") + 1);
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      if (method === "setWebhook") webhookByToken.set(token, String(body.url));
      if (method === "deleteWebhook") {
        webhookByToken.set(token, null);
        if (injectActivationFailure && token === REPLACEMENT_OLD_BOT_TOKEN) {
          injectActivationFailure = false;
          runtime.database.failNextBatchOn("UPDATE telegram_credentials SET status = 'revoked'");
          runtime.database.failNextFirstOn("active_credential_id AS activeCredentialId");
        }
      }
      const botId = token === REPLACEMENT_OLD_BOT_TOKEN ? 111_111_111 : 222_222_222;
      const botIdText = String(botId);
      const result: Record<string, unknown> | boolean = method === "getMe"
        ? { first_name: `Bot ${botIdText}`, id: botId, is_bot: true, username: `bot_${botIdText}_bot` }
        : method === "getWebhookInfo"
          ? {
              allowed_updates: ["message", "callback_query"],
              max_connections: 20,
              pending_update_count: 0,
              url: webhookByToken.get(token) ?? "",
            }
          : true;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
    };

    await connectTelegram({
      botToken: REPLACEMENT_OLD_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: false,
      requestId: "telegram-readback-old-connect",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    });
    injectActivationFailure = true;

    await expect(connectTelegram({
      botToken: REPLACEMENT_NEW_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: true,
      requestId: "telegram-readback-new-replace",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    })).rejects.toMatchObject({ code: "telegram_activation_failed" });

    const integration = runtime.database.database.prepare(`
      SELECT status, active_credential_id AS activeCredentialId, bot_id AS botId
      FROM telegram_integrations WHERE shop_id = 'shop-telegram-runtime'
    `).get() as { activeCredentialId: string; botId: string; status: string };
    expect(integration).toMatchObject({ botId: "111111111", status: "degraded" });
    expect(integration.activeCredentialId).not.toBeNull();
    expect(webhookByToken.get(REPLACEMENT_OLD_BOT_TOKEN)).toBeNull();
    expect(webhookByToken.get(REPLACEMENT_NEW_BOT_TOKEN)).toMatch(/^https:\/\/api\.test\/webhooks\/telegram\//u);
  });

  it("keeps the committed replacement authoritative when the activation response is lost", async () => {
    const runtime = createRuntime();
    runtime.database.database.exec(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('user-telegram-reclaim', 'telegram-reclaim@example.test', 'Reclaim owner', 'active', '${NOW}', '${NOW}');
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES (
        'shop-telegram-reclaim', 'shop-public-telegram-reclaim', 'telegram-reclaim',
        'Telegram Reclaim', 'active', 'en', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'
      );
    `);
    const webhookByToken = new Map<string, string | null>();
    let injectActivationResponseLoss = false;
    const fetcher: typeof fetch = (request, init) => {
      const url = request instanceof Request ? request.url : request.toString();
      const token = url.includes(REPLACEMENT_OLD_BOT_TOKEN)
        ? REPLACEMENT_OLD_BOT_TOKEN
        : REPLACEMENT_NEW_BOT_TOKEN;
      const method = url.slice(url.lastIndexOf("/") + 1);
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      if (method === "setWebhook") webhookByToken.set(token, String(body.url));
      if (method === "deleteWebhook") {
        webhookByToken.set(token, null);
        if (injectActivationResponseLoss && token === REPLACEMENT_OLD_BOT_TOKEN) {
          injectActivationResponseLoss = false;
          runtime.database.loseNextBatchResponseAfterCommitOn("UPDATE telegram_credentials SET status = 'revoked'");
        }
      }
      const botId = token === REPLACEMENT_OLD_BOT_TOKEN ? 111_111_111 : 222_222_222;
      const botIdText = String(botId);
      const result: Record<string, unknown> | boolean = method === "getMe"
        ? { first_name: `Bot ${botIdText}`, id: botId, is_bot: true, username: `bot_${botIdText}_bot` }
        : method === "getWebhookInfo"
          ? {
              allowed_updates: ["message", "callback_query"],
              max_connections: 20,
              pending_update_count: 0,
              url: webhookByToken.get(token) ?? "",
            }
          : true;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
    };

    await connectTelegram({
      botToken: REPLACEMENT_OLD_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: false,
      requestId: "telegram-response-loss-old-connect",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    });
    injectActivationResponseLoss = true;
    const replacement = await connectTelegram({
      botToken: REPLACEMENT_NEW_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: true,
      requestId: "telegram-response-loss-new-replace",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    });
    expect(replacement.bot?.id).toBe("222222222");
    const replacementWebhook = webhookByToken.get(REPLACEMENT_NEW_BOT_TOKEN);
    expect(replacementWebhook).toMatch(/^https:\/\/api\.test\/webhooks\/telegram\//u);

    await expect(connectTelegram({
      botToken: REPLACEMENT_OLD_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: false,
      requestId: "telegram-response-loss-old-reclaim",
      shopPublicId: "shop-public-telegram-reclaim",
      userId: "user-telegram-reclaim",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    const reclaimedWebhook = webhookByToken.get(REPLACEMENT_OLD_BOT_TOKEN);

    await expect(connectTelegram({
      botToken: REPLACEMENT_NEW_BOT_TOKEN,
      env: runtime.env,
      fetcher,
      replaceBot: false,
      requestId: "telegram-response-loss-new-retry",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    })).resolves.toMatchObject({ bot: { id: "222222222" }, status: "active", webhookStatus: "verified" });
    expect(webhookByToken.get(REPLACEMENT_NEW_BOT_TOKEN)).toBe(replacementWebhook);
    expect(webhookByToken.get(REPLACEMENT_OLD_BOT_TOKEN)).toBe(reclaimedWebhook);
  });

  it("keeps a resumed credential active when its activation response is lost after commit", async () => {
    const runtime = createRuntime();
    runtime.setWebhookFailure(true);
    await expect(connect(runtime, "telegram-resume-response-loss-initial"))
      .rejects.toMatchObject({ code: "telegram_request_rejected" });
    runtime.setWebhookFailure(false);
    runtime.database.loseNextBatchResponseAfterCommitOn("active_credential_id IS NULL AND EXISTS");
    const deleteCount = runtime.deleteWebhookPayloads().length;

    await expect(refreshTelegramHealth({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "telegram-resume-response-loss-refresh",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(runtime.deleteWebhookPayloads()).toHaveLength(deleteCount);

    await expect(connect(runtime, "telegram-resume-response-loss-retry"))
      .resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    expect(runtime.deleteWebhookPayloads()).toHaveLength(deleteCount);
  });

  it("revokes the old credential and rejects pending updates across rotation and disconnect", async () => {
    const runtime = createRuntime();
    await connect(runtime, "telegram-generation-connect");
    expect(runtime.webhookPayloads().at(-1)).toMatchObject({ drop_pending_updates: true });
    const integration = runtime.database.database.prepare(`
      SELECT id, active_credential_id AS credentialId,
        integration_generation AS generation
      FROM telegram_integrations
    `).get() as { credentialId: string; generation: number; id: string };
    runtime.database.database.prepare(`
      INSERT INTO telegram_updates (
        id, shop_id, integration_id, credential_id, integration_generation,
        update_id, payload_hash, update_kind, status, attempts, received_at, updated_at
      ) VALUES (?, 'shop-telegram-runtime', ?, ?, ?, ?, ?, 'message', ?, 1, ?, ?)
    `).run("update-rotation-pending", integration.id, integration.credentialId, integration.generation, 501, "hash-501", "processing", NOW, NOW);

    const webhookCountBeforeBusyRotation = runtime.webhookPayloads().length;
    await expect(connectTelegram({
      botToken: ROTATED_BOT_TOKEN,
      env: runtime.env,
      fetcher: runtime.fetcher,
      replaceBot: false,
      requestId: "telegram-generation-rotate-busy",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    })).rejects.toMatchObject({ code: "telegram_integration_busy" });
    expect(runtime.webhookPayloads()).toHaveLength(webhookCountBeforeBusyRotation);

    runtime.database.database.prepare(`
      UPDATE telegram_updates SET status = 'failed', updated_at = ?
      WHERE id = 'update-rotation-pending'
    `).run(NOW);

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
        id, shop_id, integration_id, credential_id, integration_generation,
        update_id, payload_hash, update_kind, status, attempts, received_at, updated_at
      ) SELECT ?, 'shop-telegram-runtime', id, active_credential_id,
        integration_generation, ?, ?, 'message', 'failed', 1, ?, ?
      FROM telegram_integrations WHERE id = ?
    `).run("update-disconnect-pending", 502, "hash-502", NOW, NOW, integration.id);
    await disconnectTelegram({ env: runtime.env, fetcher: runtime.fetcher, requestId: "telegram-generation-disconnect", shopPublicId: "shop-public-telegram-runtime", userId: "user-telegram-runtime" });

    expect(runtime.database.database.prepare("SELECT status, safe_result_code AS resultCode FROM telegram_updates WHERE id = 'update-disconnect-pending'").get()).toEqual({ resultCode: "telegram_update_stale_generation", status: "rejected" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE resource_id = ? AND action = 'telegram.update_generation_fenced'").get(integration.id)).toEqual({ count: 2 });
    expect(runtime.deleteWebhookPayloads().at(-1)).toEqual({ drop_pending_updates: true });
    const deleteWebhookCount = runtime.deleteWebhookPayloads().length;

    await expect(disconnectTelegram({
      env: runtime.env,
      fetcher: runtime.fetcher,
      requestId: "telegram-generation-disconnect-retry",
      shopPublicId: "shop-public-telegram-runtime",
      userId: "user-telegram-runtime",
    })).resolves.toBeUndefined();
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE resource_id = ? AND action = 'telegram.update_generation_fenced'").get(integration.id)).toEqual({ count: 2 });
    expect(runtime.deleteWebhookPayloads()).toHaveLength(deleteWebhookCount);
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
    const shop: TelegramShop = { currency: "VND", currentPeriodEnd: "2099-01-01T00:00:00.000Z", defaultLocale: "vi", id: "shop-telegram-runtime", name: "Runtime", orderExpiryMinutes: 30, origin: "https://runtime.selinow.com", status: "active", subscriptionState: "active" };
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
