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

function conflictReceiptStore() {
  const claim = vi.fn((event: ProviderReceiptClaim["event"]): Promise<ProviderReceiptClaim> => Promise.resolve({ event, result: "conflict" }));
  return { claim } satisfies ProviderReceiptStore;
}

async function contextRow() {
  const envelope = await encryptWhatsAppCloudCredential({
    appSecret: APP_SECRET,
    businessAccountId: "waba-001",
    connectionId: CONNECTION_ID,
    credentialId: CREDENTIAL_ID,
    hmacSecret: HMAC_SECRET,
    kek: KEK,
    keyVersion: "v1",
    shopId: SHOP_ID,
    phoneNumberId: "phone-001",
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
    subscriptionState: "active",
    trialEndsAt: null,
    graceEndsAt: null,
  };
}

function webhookBody(businessAccountId = "waba-001", phoneNumberId = "phone-001"): string {
  return JSON.stringify({
    entry: [{ id: businessAccountId, changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ id: "wamid.abc" }] } }] }],
    object: "whatsapp_business_account",
  });
}

function accountWebhookBody(): string {
  return JSON.stringify({
    entry: [{ id: "waba-001", changes: [{ field: "account_update", value: { event: "PARTNER_APP_INSTALLED" } }] }],
    object: "whatsapp_business_account",
  });
}

function statusWebhookBody(businessAccountId = "waba-001", phoneNumberId = "phone-001"): string {
  return JSON.stringify({
    entry: [{ id: businessAccountId, changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, statuses: [{ id: "wamid.abc", status: "delivered" }] } }] }],
    object: "whatsapp_business_account",
  });
}

function templateQualityWebhookBody(): string {
  return JSON.stringify({
    entry: [{ id: "waba-001", changes: [{ field: "message_template_quality_update", value: { message_template_id: 123, new_quality: "GREEN" } }] }],
    object: "whatsapp_business_account",
  });
}

function unknownWabaChangeBody(): string {
  return JSON.stringify({
    entry: [{ id: "waba-001", changes: [{ field: "phone_number_quality_update", value: { quality: "GREEN" } }] }],
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

  it("rejects a changed-payload receipt conflict instead of acknowledging it", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    const body = webhookBody();
    await expect(processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      receiptStore: conflictReceiptStore(),
      request: new Request("https://api.test/webhooks/whatsapp", {
        body,
        headers: { "X-Hub-Signature-256": await hmacSignature(body) },
        method: "POST",
      }),
    })).rejects.toMatchObject({ code: "channel_provider_event_conflict", status: 409 });
  });

  it("rejects a signed event from a different WABA or phone number", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    const body = webhookBody("waba-other", "phone-other");
    await expect(processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      receiptStore: receiptStore(),
      request: new Request("https://api.test/webhooks/whatsapp", {
        body,
        headers: { "X-Hub-Signature-256": await hmacSignature(body) },
        method: "POST",
      }),
    })).rejects.toMatchObject({ code: "channel_tenant_mismatch", status: 403 });
  });

  it("accepts WABA-level account and template events without phone metadata", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    for (const body of [accountWebhookBody(), templateQualityWebhookBody()]) {
      const result = await processWhatsAppWebhook({
        connectionPublicId: CONNECTION_PUBLIC_ID,
        env: bindings(database),
        receiptStore: receiptStore(),
        request: new Request("https://api.test/webhooks/whatsapp", {
          body,
          headers: { "X-Hub-Signature-256": await hmacSignature(body) },
          method: "POST",
        }),
      });
      expect(result.action).toBe("event.received");
    }
  });

  it("rejects unrecognized changes without phone metadata instead of claiming a cross-phone event", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    const body = unknownWabaChangeBody();
    const store = receiptStore();
    await expect(processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      receiptStore: store,
      request: new Request("https://api.test/webhooks/whatsapp", {
        body,
        headers: { "X-Hub-Signature-256": await hmacSignature(body) },
        method: "POST",
      }),
    })).rejects.toMatchObject({ code: "channel_webhook_invalid", status: 400 });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("keeps a status update distinct from the message id it references", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    const store = receiptStore();
    const body = statusWebhookBody();
    const result = await processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      receiptStore: store,
      request: new Request("https://api.test/webhooks/whatsapp", {
        body,
        headers: { "X-Hub-Signature-256": await hmacSignature(body) },
        method: "POST",
      }),
    });
    expect(result).toEqual({ action: "message.status", eventId: "status:wamid.abc", result: "accepted" });
  });

  it("rejects phone-scoped changes with malformed metadata", async () => {
    const row = await contextRow();
    const database = fakeDatabase(row);
    const body = JSON.stringify({
      entry: [{ id: "waba-001", changes: [{ field: "messages", value: { metadata: {}, messages: [{ id: "wamid.abc" }] } }] }],
      object: "whatsapp_business_account",
    });
    await expect(processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(database),
      receiptStore: receiptStore(),
      request: new Request("https://api.test/webhooks/whatsapp", {
        body,
        headers: { "X-Hub-Signature-256": await hmacSignature(body) },
        method: "POST",
      }),
    })).rejects.toMatchObject({ code: "channel_webhook_invalid", status: 400 });
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

  it("rejects an invalid GET mode or verification token", async () => {
    const row = await contextRow();
    const env = bindings(fakeDatabase(row));
    await expect(verifyWhatsAppChallengeRequest({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env,
      request: new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}?hub.mode=unsubscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=123456789`),
    })).rejects.toMatchObject({ code: "channel_route_invalid", status: 401 });
    await expect(verifyWhatsAppChallengeRequest({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env,
      request: new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}?hub.mode=subscribe&hub.verify_token=wrong-token-value&hub.challenge=123456789`),
    })).rejects.toMatchObject({ code: "channel_route_invalid", status: 401 });
    await expect(verifyWhatsAppChallengeRequest({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env,
      request: new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}?hub.mode=subscribe&hub.verify_token=${"x".repeat(513)}&hub.challenge=123456789`),
    })).rejects.toMatchObject({ code: "channel_route_invalid", status: 401 });
    await expect(verifyWhatsAppChallengeRequest({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env,
      request: new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.verify_token=duplicate&hub.challenge=123456789`),
    })).rejects.toMatchObject({ code: "channel_route_invalid", status: 401 });
  });

  it("does not verify a challenge when the connection has no active credential", async () => {
    const row = await contextRow();
    await expect(verifyWhatsAppChallengeRequest({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env: bindings(fakeDatabase({ ...row, credentialStatus: null })),
      request: new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=123456789`),
    })).rejects.toMatchObject({ code: "channel_credential_unavailable", status: 503 });
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
