import { describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { encryptTelegramCredential } from "../../src/lib/telegram/crypto";
import type { TelegramUpdate } from "../../src/lib/telegram/types";
import { isDraftTelegramHealthStart, processTelegramWebhook } from "../../src/lib/telegram/webhooks";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDE";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WEBHOOK_SECRET = "draft-health-secret_123456789";

function messageUpdate(text: string, chatType: "group" | "private" = "private"): TelegramUpdate {
  return {
    chat: { id: chatType === "private" ? 42 : -42, type: chatType },
    kind: "message",
    messageId: 7,
    text,
    updateId: 100,
    user: { firstName: "Seller", id: 42, isBot: false, languageCode: "vi", lastName: null, username: "seller" },
  };
}

async function draftEnvironment(options: {
  failPostSendHealthEvidenceOnce?: boolean;
  rotateCredentialOnReply?: boolean;
} = {}) {
  const encrypted = await encryptTelegramCredential({
    botToken: BOT_TOKEN,
    credentialId: "credential-a",
    hmacSecret: "identifier-secret",
    integrationId: "integration-a",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
    webhookSecret: WEBHOOK_SECRET,
  });
  const sqlHistory: string[] = [];
  const resultCodes: string[] = [];
  let healthUpdated = false;
  let providerCalls = 0;
  let activeCredentialId = "credential-a";
  let updateRow: { id: string; payloadHash: string; status: string; updatedAt: string } | null = null;
  let failPostSendHealthEvidence = options.failPostSendHealthEvidenceOnce === true;
  const staleAudits: Array<{ metadata: unknown; requestId: string }> = [];

  const database = {
    prepare(sql: string) {
      sqlHistory.push(sql);
      return {
        bind(...values: unknown[]) {
          return {
            first() {
              if (sql.includes("telegram_integrations.active_credential_id = ?")) {
                return Promise.resolve(activeCredentialId === values[2] ? { activeCredentialId } : null);
              }
              if (sql.includes("FROM telegram_integrations") && sql.includes("INNER JOIN telegram_credentials")) {
                return Promise.resolve({
                  ...encrypted,
                  activeCredentialId,
                  botDisplayName: "Draft Bot",
                  botUsername: "draft_bot",
                  credentialId: "credential-a",
                  integrationId: "integration-a",
                  integrationStatus: "active",
                  keyVersion: "v1",
                  shopId: "shop-a",
                  shopName: "Draft shop",
                  shopStatus: "draft",
                  status: "active",
                  subscriptionState: "trialing",
                  trialEndsAt: "2099-01-01T00:00:00.000Z",
                  graceEndsAt: null,
                });
              }
              if (sql.includes("FROM telegram_updates")) {
                return Promise.resolve(updateRow === null ? null : { ...updateRow });
              }
              return Promise.resolve(null);
            },
            run() {
              if (sql.includes("INSERT INTO telegram_updates")) {
                updateRow = {
                  id: String(values[0]),
                  payloadHash: String(values[6]),
                  status: "processing",
                  updatedAt: String(values[8]),
                };
              }
              if (sql.includes("UPDATE telegram_updates SET status = 'processing'") && updateRow !== null) {
                updateRow.status = "processing";
                updateRow.updatedAt = String(values[0]);
              }
              if (failPostSendHealthEvidence && providerCalls > 0 && sql.includes("SET last_health_update_at")) {
                failPostSendHealthEvidence = false;
                throw new Error("forced_post_send_health_evidence_failure");
              }
              if (sql.includes("SET last_health_update_at")) healthUpdated = activeCredentialId === String(values[6]);
              if (sql.includes("SET status = 'processed'") && updateRow !== null) {
                updateRow.status = "processed";
                updateRow.updatedAt = String(values[2]);
                resultCodes.push(String(values[0]));
              }
              if (sql.includes("UPDATE telegram_updates SET status = 'failed'") && updateRow !== null && updateRow.status !== "processed") {
                updateRow.status = "failed";
                updateRow.updatedAt = String(values[1]);
              }
              if (sql.includes("telegram.update_stale_generation")) staleAudits.push({ metadata: JSON.parse(String(values[3])), requestId: String(values[4]) });
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
    expect(body.chat_id).toBe("42");
    if (options.rotateCredentialOnReply === true) activeCredentialId = "credential-rotated";
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
  };
  const env = {
    CREDENTIAL_KEK_V1: KEK,
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
    PLATFORM_DB: database,
  } as unknown as AppBindings;

  return {
    env,
    fetcher,
    getHealthUpdated: () => healthUpdated,
    getProviderCalls: () => providerCalls,
    getStaleAudits: () => staleAudits,
    rotateCredential: () => { activeCredentialId = "credential-rotated"; },
    resultCodes,
    sqlHistory,
  };
}

function webhookRequest(update: Record<string, unknown>): Request {
  return new Request("https://api.test/webhooks/telegram/tgwh_test", {
    body: JSON.stringify(update),
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
    method: "POST",
  });
}

describe("draft Telegram health", () => {
  it("accepts only an exact private /start command", () => {
    expect(isDraftTelegramHealthStart(messageUpdate("/start"))).toBe(true);
    expect(isDraftTelegramHealthStart(messageUpdate("/START@draft_bot"))).toBe(true);
    expect(isDraftTelegramHealthStart(messageUpdate("/start payload"))).toBe(false);
    expect(isDraftTelegramHealthStart(messageUpdate("/products"))).toBe(false);
    expect(isDraftTelegramHealthStart(messageUpdate("/start", "group"))).toBe(false);
    expect(isDraftTelegramHealthStart({ callbackId: "callback-a", chat: { id: 42, type: "private" }, data: "menu", kind: "callback_query", messageId: 7, updateId: 101, user: messageUpdate("/start").user })).toBe(false);
  });

  it("records private /start health without entering commerce", async () => {
    const runtime = await draftEnvironment();
    const result = await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest({ message: { chat: { id: 42, type: "private" }, from: { first_name: "Seller", id: 42, is_bot: false, language_code: "vi", username: "seller" }, message_id: 7, text: "/start" }, update_id: 100 }),
      requestId: "request-draft-health",
      webhookPublicId: "tgwh_test",
    });

    expect(result).toMatchObject({ processed: true, state: "draft_health_confirmed" });
    expect(runtime.getHealthUpdated()).toBe(true);
    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.resultCodes).toContain("draft_health_confirmed");
    expect(runtime.sqlHistory.join("\n")).not.toMatch(/shop_customers|customer_identities|\bcarts\b|\borders\b|inventory_keys/u);
  });

  it("does not restore health evidence after the active credential rotates during the reply", async () => {
    const runtime = await draftEnvironment({ rotateCredentialOnReply: true });
    const result = await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest({ message: { chat: { id: 42, type: "private" }, from: { first_name: "Seller", id: 42, is_bot: false, language_code: "vi", username: "seller" }, message_id: 7, text: "/start" }, update_id: 100 }),
      requestId: "request-draft-rotated-health",
      webhookPublicId: "tgwh_test",
    });

    expect(result).toMatchObject({ processed: true, state: "draft_health_confirmed" });
    expect(runtime.getHealthUpdated()).toBe(false);
  });

  it("does not resend draft health confirmation after provider success and D1 evidence failure", async () => {
    const runtime = await draftEnvironment({ failPostSendHealthEvidenceOnce: true });

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest({ message: { chat: { id: 42, type: "private" }, from: { first_name: "Seller", id: 42, is_bot: false, language_code: "vi", username: "seller" }, message_id: 7, text: "/start" }, update_id: 100 }),
      requestId: "request-draft-health-evidence-failure",
      webhookPublicId: "tgwh_test",
    })).rejects.toThrow("forced_post_send_health_evidence_failure");
    expect(runtime.getProviderCalls()).toBe(1);

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest({ message: { chat: { id: 42, type: "private" }, from: { first_name: "Seller", id: 42, is_bot: false, language_code: "vi", username: "seller" }, message_id: 7, text: "/start" }, update_id: 100 }),
      requestId: "request-draft-health-evidence-replay",
      webhookPublicId: "tgwh_test",
    })).resolves.toMatchObject({ duplicate: true, processed: false, state: "duplicate" });
    expect(runtime.getProviderCalls()).toBe(1);
  });

  it.each(["/products", "/cart", "/orders", "/keys"])("blocks draft commerce command %s before provider or commerce work", async (command) => {
    const runtime = await draftEnvironment();
    const result = await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest({ message: { chat: { id: 42, type: "private" }, from: { first_name: "Seller", id: 42, is_bot: false }, message_id: 7, text: command }, update_id: 100 }),
      requestId: "request-draft-blocked",
      webhookPublicId: "tgwh_test",
    });

    expect(result.state).toBe("draft_action_blocked");
    expect(runtime.getHealthUpdated()).toBe(false);
    expect(runtime.getProviderCalls()).toBe(0);
    expect(runtime.resultCodes).toContain("draft_action_blocked");
    expect(runtime.sqlHistory.join("\n")).not.toMatch(/shop_customers|customer_identities|\bcarts\b|\borders\b|inventory_keys/u);
  });
});
