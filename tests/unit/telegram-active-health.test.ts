import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { encryptTelegramCredential } from "../../src/lib/telegram/crypto";

const commerce = vi.hoisted(() => ({ handle: vi.fn() }));

vi.mock("../../src/lib/telegram/commerce", () => ({
  handleTelegramCommerce: commerce.handle,
}));

import { processTelegramWebhook } from "../../src/lib/telegram/webhooks";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDE";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WEBHOOK_SECRET = "active-health-secret_123456789";

async function activeEnvironment(options: { failUpdateInsert?: boolean; rotateCredentialOnReply?: boolean } = {}) {
  const encrypted = await encryptTelegramCredential({
    botToken: BOT_TOKEN,
    credentialId: "credential-active",
    hmacSecret: "identifier-secret",
    integrationId: "integration-active",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-active",
    webhookSecret: WEBHOOK_SECRET,
  });
  const resultCodes: string[] = [];
  let healthUpdated = false;
  let providerCalls = 0;
  let activeCredentialId = "credential-active";
  let updateReadCount = 0;

  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first() {
              if (sql.includes("FROM telegram_integrations") && sql.includes("INNER JOIN telegram_credentials")) {
                return Promise.resolve({
                  ...encrypted,
                  botDisplayName: "Active Bot",
                  botUsername: "active_bot",
                  credentialId: "credential-active",
                  integrationId: "integration-active",
                  integrationStatus: "active",
                  keyVersion: "v1",
                  shopId: "shop-active",
                  shopName: "Active shop",
                  shopStatus: "active",
                  status: "active",
                  subscriptionState: "active",
                });
              }
              if (sql.includes("FROM telegram_updates")) {
                updateReadCount += 1;
                return Promise.resolve(null);
              }
              return Promise.resolve(null);
            },
            run() {
              if (options.failUpdateInsert === true && sql.includes("INSERT INTO telegram_updates")) {
                throw new Error("forced_telegram_update_failure");
              }
              if (sql.includes("last_health_update_at = COALESCE") && typeof values[1] === "string") {
                healthUpdated = activeCredentialId === String(values[4]);
              }
              if (sql.includes("UPDATE telegram_updates SET status = 'processed'")) resultCodes.push(String(values[0]));
              return Promise.resolve({ meta: { changes: 1 } });
            },
          };
        },
      };
    },
    batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const fetcher: typeof fetch = (_input, init) => {
    providerCalls += 1;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    if (body.callback_query_id !== undefined) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    expect(body.chat_id).toBe("42");
    if (options.rotateCredentialOnReply === true) activeCredentialId = "credential-rotated";
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
  };

  return {
    env: {
      CREDENTIAL_KEK_V1: KEK,
      IDENTIFIER_HMAC_SECRET: "identifier-secret",
      PLATFORM_DB: database,
    } as unknown as AppBindings,
    fetcher,
    getHealthUpdated: () => healthUpdated,
    getProviderCalls: () => providerCalls,
    getUpdateReadCount: () => updateReadCount,
    resultCodes,
  };
}

function webhookRequest(text: string): Request {
  return new Request("https://api.test/webhooks/telegram/tgwh_active", {
    body: JSON.stringify({
      message: {
        chat: { id: 42, type: "private" },
        from: { first_name: "Seller", id: 42, is_bot: false, language_code: "vi", username: "seller" },
        message_id: 7,
        text,
      },
      update_id: 100,
    }),
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
    method: "POST",
  });
}

beforeEach(() => {
  commerce.handle.mockReset();
  commerce.handle.mockResolvedValue({
    identity: { chatId: "42", identityId: "identity-active" },
    reply: { text: "Active shop welcome" },
    resultCode: "telegram_start",
  });
});

describe("active Telegram health evidence", () => {
  it("refreshes health evidence after a successful private /start commerce response", async () => {
    const runtime = await activeEnvironment();

    const result = await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/start"),
      requestId: "request-active-start",
      webhookPublicId: "tgwh_active",
    });

    expect(result).toMatchObject({ processed: true, state: "telegram_start" });
    expect(commerce.handle).toHaveBeenCalledOnce();
    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.getHealthUpdated()).toBe(true);
    expect(runtime.resultCodes).toContain("telegram_start");
  });

  it("does not treat another active commerce command as health evidence", async () => {
    const runtime = await activeEnvironment();

    await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/products"),
      requestId: "request-active-products",
      webhookPublicId: "tgwh_active",
    });

    expect(runtime.getHealthUpdated()).toBe(false);
  });

  it("does not restore health evidence after the active credential rotates during the reply", async () => {
    const runtime = await activeEnvironment({ rotateCredentialOnReply: true });

    const result = await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/start"),
      requestId: "request-active-rotated-start",
      webhookPublicId: "tgwh_active",
    });

    expect(result).toMatchObject({ processed: true, state: "telegram_start" });
    expect(runtime.getHealthUpdated()).toBe(false);
  });

  it("fails closed after one collision re-read when an update receipt cannot be stored", async () => {
    const runtime = await activeEnvironment({ failUpdateInsert: true });

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/start"),
      requestId: "request-update-storage-failure",
      webhookPublicId: "tgwh_active",
    })).rejects.toMatchObject({ code: "telegram_update_record_failed", status: 500 });

    expect(runtime.getUpdateReadCount()).toBe(2);
    expect(runtime.getProviderCalls()).toBe(0);
    expect(commerce.handle).not.toHaveBeenCalled();
  });

  it("acknowledges inline callbacks without entering private-chat commerce", async () => {
    const runtime = await activeEnvironment();
    const result = await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: new Request("https://api.test/webhooks/telegram/tgwh_active", {
        body: JSON.stringify({
          callback_query: {
            from: { first_name: "Buyer", id: 42, is_bot: false },
            id: "callback-inline",
            inline_message_id: "inline-message-1",
          },
          update_id: 106,
        }),
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
        method: "POST",
      }),
      requestId: "request-inline-callback",
      webhookPublicId: "tgwh_active",
    });

    expect(result).toMatchObject({ processed: true, state: "callback_unsupported" });
    expect(commerce.handle).not.toHaveBeenCalled();
    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.resultCodes).toContain("callback_unsupported");
  });
});
