import { describe, expect, it, vi } from "vitest";

import { toBase64Url } from "../../src/lib/core/ids";
import { encryptWhatsAppCloudCredential } from "../../src/lib/channels/whatsapp-credentials";
import { processWhatsAppWebhook, verifyWhatsAppChallengeRequest } from "../../src/lib/channels/whatsapp-webhooks";
import type { ProviderReceiptClaim, ProviderReceiptStore } from "../../src/lib/channels/ingress";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const SHOP_ID = "shop-001";
const CONNECTION_ID = "connection-001";
const CONNECTION_PUBLIC_ID = "whatsapp-connection-001";
const CREDENTIAL_ID = "credential-001";
const APP_SECRET = "whatsapp-app-secret-123456";
const VERIFY_TOKEN = "whatsapp-verify-token-123456";
const HMAC_SECRET = "identifier-hmac-secret";
const KEK = toBase64Url(new Uint8Array(32).fill(7));

async function hmacSignature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function fakeDatabase(row: Record<string, unknown>) {
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => {
      void values;
      return {
        first: <T>() => Promise.resolve(sql.includes("FROM channel_connections") ? row as T : null),
        run: () => Promise.resolve({ meta: { changes: 1 } }),
      };
    },
  }));
  return { prepare };
}

function bindings(database: ReturnType<typeof fakeDatabase>): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    APP_ENV: "local",
    CREDENTIAL_KEK_V1: KEK,
    IDENTIFIER_HMAC_SECRET: HMAC_SECRET,
    PLATFORM_DB: database,
  } as unknown as AppBindings;
}

function receiptStore() {
  const claim = vi.fn((event: ProviderReceiptClaim["event"]): Promise<ProviderReceiptClaim> => Promise.resolve({ event, result: "accepted" }));
  return { claim } satisfies ProviderReceiptStore;
}

async function contextRow() {
  const envelope = await encryptWhatsAppCloudCredential({
    appSecret: APP_SECRET,
    connectionId: CONNECTION_ID,
    credentialId: CREDENTIAL_ID,
    hmacSecret: HMAC_SECRET,
    kek: KEK,
    keyVersion: "v1",
    shopId: SHOP_ID,
    verifyToken: VERIFY_TOKEN,
  });
  return {
    connectionId: CONNECTION_ID,
    connectionPublicId: CONNECTION_PUBLIC_ID,
    credentialEnvelopeCiphertextB64: envelope.credentialEnvelopeCiphertextB64,
    credentialEnvelopeIvB64: envelope.credentialEnvelopeIvB64,
    credentialFingerprint: envelope.credentialFingerprint,
    credentialId: CREDENTIAL_ID,
    credentialStatus: "active",
    keyVersion: envelope.keyVersion,
    providerCode: "whatsapp.cloud",
    shopId: SHOP_ID,
  };
}

function webhookBody(): string {
  return JSON.stringify({
    entry: [{ id: "waba-001", changes: [{ field: "messages", value: { messages: [{ id: "wamid.abc" }] } }] }],
    object: "whatsapp_business_account",
  });
}

describe("WhatsApp Cloud webhook route service", () => {
  it("verifies raw bytes, binds the connection, and claims a reference-only receipt", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    const env = bindings(database);
    const store = receiptStore();
    const body = webhookBody();
    const result = await processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env,
      now: NOW,
      receiptStore: store,
      request: new Request("https://api.test/webhooks/whatsapp", { body, headers: { "X-Hub-Signature-256": await hmacSignature(body) }, method: "POST" }),
    });
    expect(result).toEqual({ action: "message.received", eventId: "wamid.abc", result: "accepted" });
    expect(store.claim).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.claim.mock.calls[0]?.[0])).not.toContain("messages");
  });

  it("does not claim when the raw-body signature is invalid", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    const store = receiptStore();
    const body = webhookBody();
    await expect(processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      receiptStore: store,
      request: new Request("https://api.test/webhooks/whatsapp", { body: `${body} `, headers: { "X-Hub-Signature-256": await hmacSignature(body) }, method: "POST" }),
    })).rejects.toMatchObject({ code: "channel_webhook_invalid", status: 401 });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("returns the verified GET challenge without exposing credential material", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    const challenge = await verifyWhatsAppChallengeRequest({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      request: new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=123456789`),
    });
    expect(challenge).toBe("123456789");
    expect(challenge).not.toContain(APP_SECRET);
  });

  it("fails closed when the connection has no active credential", async () => {
    const row = await contextRow();
    const database = fakeDatabase({ ...row, credentialStatus: null });
    const store = receiptStore();
    await expect(processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      receiptStore: store,
      request: new Request("https://api.test/webhooks/whatsapp", { body: webhookBody(), method: "POST" }),
    })).rejects.toMatchObject({ code: "channel_credential_unavailable", status: 503 });
    expect(store.claim).not.toHaveBeenCalled();
  });
});
