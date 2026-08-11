import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";
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

async function activeEnvironment(options: {
  failPostSendEvidenceOnce?: boolean;
  failReplyClaims?: boolean;
  failReplyFinalizationOnce?: boolean;
  failUpdateInsert?: boolean;
  rotateCredentialOnReply?: boolean;
} = {}) {
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
  let updateRow: { id: string; payloadHash: string; status: string; updatedAt: string } | null = null;
  let failPostSendEvidence = options.failPostSendEvidenceOnce === true;
  let failReplyFinalization = options.failReplyFinalizationOnce === true;
  const staleAudits: Array<{ metadata: unknown; requestId: string }> = [];

  const database = {
    prepare(sql: string) {
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
                  currentPeriodEnd: "2099-01-01T00:00:00.000Z",
                });
              }
              if (sql.includes("FROM telegram_updates")) {
                updateReadCount += 1;
                return Promise.resolve(updateRow === null ? null : { ...updateRow });
              }
              return Promise.resolve(null);
            },
            run() {
              if (options.failUpdateInsert === true && sql.includes("INSERT INTO telegram_updates")) {
                throw new Error("forced_telegram_update_failure");
              }
              if (sql.includes("INSERT INTO telegram_updates")) {
                updateRow = {
                  id: String(values[0]),
                  payloadHash: String(values[4]),
                  status: "processing",
                  updatedAt: String(values[8]),
                };
              }
              if (sql.includes("UPDATE telegram_updates SET status = 'processing'") && updateRow !== null) {
                updateRow.status = "processing";
                updateRow.updatedAt = String(values[0]);
              }
              if (failPostSendEvidence && providerCalls > 0 && sql.includes("UPDATE telegram_recipients")) {
                failPostSendEvidence = false;
                throw new Error("forced_post_send_evidence_failure");
              }
              if (sql.includes("last_health_update_at = COALESCE") && typeof values[1] === "string") {
                healthUpdated = activeCredentialId === String(values[5]);
              }
              if (failReplyFinalization && providerCalls > 0 && sql.includes("SET status = 'processed'")) {
                failReplyFinalization = false;
                throw new Error("forced_reply_finalization_failure");
              }
              if (options.failReplyClaims === true && sql.includes("SET status = 'processed'")) {
                throw new Error("forced_reply_claim_failure");
              }
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
    if (body.callback_query_id !== undefined) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    expect(new Set(["-42", "42"]).has(String(body.chat_id))).toBe(true);
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
    getStaleAudits: () => staleAudits,
    getUpdateReadCount: () => updateReadCount,
    resultCodes,
    rotateCredential: () => { activeCredentialId = "credential-rotated"; },
  };
}

function webhookRequest(text: string, chatType: "group" | "private" = "private"): Request {
  return new Request("https://api.test/webhooks/telegram/tgwh_active", {
    body: JSON.stringify({
      message: {
        chat: { id: chatType === "private" ? 42 : -42, type: chatType },
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

function inlineCallbackRequest(): Request {
  return new Request("https://api.test/webhooks/telegram/tgwh_active", {
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
  });
}

function callbackRequest(): Request {
  return new Request("https://api.test/webhooks/telegram/tgwh_active", {
    body: JSON.stringify({
      callback_query: {
        data: "cart",
        from: { first_name: "Buyer", id: 42, is_bot: false },
        id: "callback-message",
        message: { chat: { id: 42, type: "private" }, message_id: 8 },
      },
      update_id: 107,
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

  it("discards an update when the credential generation changes during commerce", async () => {
    const runtime = await activeEnvironment();
    commerce.handle.mockImplementationOnce(() => {
      runtime.rotateCredential();
      return Promise.resolve({
        identity: { chatId: "42", identityId: "identity-active" },
        reply: { text: "stale reply must not be sent" },
        resultCode: "telegram_start",
      });
    });

    const result = await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/start"),
      requestId: "request-active-generation-race",
      webhookPublicId: "tgwh_active",
    });

    expect(result).toMatchObject({ processed: false, state: "stale_generation" });
    expect(commerce.handle).toHaveBeenCalledOnce();
    expect(runtime.getProviderCalls()).toBe(0);
    expect(runtime.getStaleAudits()).toEqual([{
      metadata: { updateId: 100 },
      requestId: "request-active-generation-race",
    }]);
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

  it("does not resend a reply after provider success when post-send D1 evidence fails", async () => {
    const runtime = await activeEnvironment({ failPostSendEvidenceOnce: true });

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/start"),
      requestId: "request-post-send-evidence-failure",
      webhookPublicId: "tgwh_active",
    })).rejects.toThrow("forced_post_send_evidence_failure");
    expect(runtime.getProviderCalls()).toBe(1);

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/start"),
      requestId: "request-post-send-evidence-replay",
      webhookPublicId: "tgwh_active",
    })).resolves.toMatchObject({ duplicate: true, processed: false, state: "duplicate" });

    expect(runtime.getProviderCalls()).toBe(1);
    expect(commerce.handle).toHaveBeenCalledOnce();
  });

  it("does not resend a non-private reply when terminal persistence fails after provider success", async () => {
    const runtime = await activeEnvironment({ failReplyFinalizationOnce: true });

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/start", "group"),
      requestId: "request-non-private-finalization-failure",
      webhookPublicId: "tgwh_active",
    })).resolves.toMatchObject({ processed: true, state: "private_chat_required" });
    expect(runtime.getProviderCalls()).toBe(1);

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: webhookRequest("/start", "group"),
      requestId: "request-non-private-finalization-replay",
      webhookPublicId: "tgwh_active",
    })).resolves.toMatchObject({ duplicate: true, processed: false, state: "duplicate" });
    expect(runtime.getProviderCalls()).toBe(1);
  });

  it("does not repeat an inline callback answer when post-provider finalization would fail", async () => {
    const runtime = await activeEnvironment({ failReplyFinalizationOnce: true });

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: inlineCallbackRequest(),
      requestId: "request-inline-finalization-failure",
      webhookPublicId: "tgwh_active",
    })).resolves.toMatchObject({ processed: true, state: "callback_unsupported" });
    expect(runtime.getProviderCalls()).toBe(1);

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: inlineCallbackRequest(),
      requestId: "request-inline-finalization-replay",
      webhookPublicId: "tgwh_active",
    })).resolves.toMatchObject({ duplicate: true, processed: false, state: "duplicate" });
    expect(runtime.getProviderCalls()).toBe(1);
  });

  it("does not repeat an error callback after commerce fails", async () => {
    const runtime = await activeEnvironment();
    commerce.handle.mockRejectedValue(new AppError("cart_invalid", 409));

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: callbackRequest(),
      requestId: "request-error-callback-first",
      webhookPublicId: "tgwh_active",
    })).rejects.toMatchObject({ code: "cart_invalid" });
    expect(runtime.getProviderCalls()).toBe(1);

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: callbackRequest(),
      requestId: "request-error-callback-replay",
      webhookPublicId: "tgwh_active",
    })).resolves.toMatchObject({ duplicate: true, processed: false, state: "duplicate" });
    expect(runtime.getProviderCalls()).toBe(1);
    expect(commerce.handle).toHaveBeenCalledOnce();
  });

  it("does not call the provider when a durable reply attempt cannot be claimed", async () => {
    const runtime = await activeEnvironment({ failReplyClaims: true });

    await expect(processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: callbackRequest(),
      requestId: "request-reply-claim-failure",
      webhookPublicId: "tgwh_active",
    })).rejects.toThrow("forced_reply_claim_failure");
    expect(runtime.getProviderCalls()).toBe(0);
  });

  it("acknowledges inline callbacks without entering private-chat commerce", async () => {
    const runtime = await activeEnvironment();
    const result = await processTelegramWebhook({
      env: runtime.env,
      fetcher: runtime.fetcher,
      request: inlineCallbackRequest(),
      requestId: "request-inline-callback",
      webhookPublicId: "tgwh_active",
    });

    expect(result).toMatchObject({ processed: true, state: "callback_unsupported" });
    expect(commerce.handle).not.toHaveBeenCalled();
    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.resultCodes).toContain("callback_unsupported");
  });
});
