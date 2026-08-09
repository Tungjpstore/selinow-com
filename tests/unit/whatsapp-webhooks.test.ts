import { describe, expect, it, vi } from "vitest";

import {
  extractWhatsAppEventDescriptor,
  loadWhatsAppWebhookContext,
  processWhatsAppWebhook,
  verifyWhatsAppChallengeRequest,
} from "../../src/lib/channels/whatsapp-webhooks";
import type { ProviderReceiptClaim, ProviderReceiptStore } from "../../src/lib/channels/ingress";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { GET, POST } from "../../src/pages/webhooks/whatsapp/[connectionPublicId]";

// Astro route imports bindings at module load; keep this unit test on the
// admission boundary and prove getBindings is never reached while pending.
vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: vi.fn(() => {
    throw new Error("provider-pending route must not resolve runtime bindings");
  }),
}));

const CONNECTION_PUBLIC_ID = "whatsapp-connection-001";
const REQUEST_ID = "request-whatsapp-pending-0001";

function bodyBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function blockedBindings() {
  const prepare = vi.fn(() => {
    throw new Error("provider-pending ingress must not query D1");
  });
  return {
    env: { PLATFORM_DB: { prepare } } as unknown as AppBindings,
    prepare,
  };
}

function receiptStore() {
  const claim = vi.fn((event: ProviderReceiptClaim["event"]): Promise<ProviderReceiptClaim> => Promise.resolve({
    event,
    result: "accepted",
  }));
  return { claim } satisfies ProviderReceiptStore;
}

describe("WhatsApp Cloud provider-pending ingress", () => {
  it("rejects POST before D1 lookup, credential decryption, body verification, or receipt persistence", async () => {
    const { env, prepare } = blockedBindings();
    const store = receiptStore();
    const request = new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}`, {
      body: JSON.stringify({ credential: "must-not-be-read", object: "whatsapp_business_account" }),
      headers: { "X-Hub-Signature-256": "sha256=must-not-be-verified" },
      method: "POST",
    });

    await expect(processWhatsAppWebhook({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env,
      receiptStore: store,
      request,
    })).rejects.toMatchObject({
      code: "channel_provider_pending",
      issues: ["whatsapp.cloud"],
      status: 409,
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it("rejects GET verification before D1 lookup or credential decryption", async () => {
    const { env, prepare } = blockedBindings();
    const request = new Request(
      `https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}?hub.mode=subscribe&hub.verify_token=must-not-be-read&hub.challenge=123456789`,
    );

    await expect(verifyWhatsAppChallengeRequest({
      connectionPublicId: CONNECTION_PUBLIC_ID,
      env,
      request,
    })).rejects.toMatchObject({
      code: "channel_provider_pending",
      issues: ["whatsapp.cloud"],
      status: 409,
    });

    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps direct context loading fail-closed so future callers cannot bypass admission", async () => {
    const { env, prepare } = blockedBindings();
    await expect(loadWhatsAppWebhookContext(env, CONNECTION_PUBLIC_ID)).rejects.toMatchObject({
      code: "channel_provider_pending",
      status: 409,
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", GET, new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}?hub.mode=subscribe&hub.verify_token=route-secret&hub.challenge=123456789`)],
    ["POST", POST, new Request(`https://api.test/webhooks/whatsapp/${CONNECTION_PUBLIC_ID}`, {
      body: JSON.stringify({ credential: "route-secret" }),
      method: "POST",
    })],
  ] as const)("returns a safe request-correlated 409 from the public %s route", async (_method, handler, request) => {
    const response = await handler({
      locals: { requestId: REQUEST_ID },
      params: { connectionPublicId: CONNECTION_PUBLIC_ID },
      request,
    } as unknown as Parameters<typeof handler>[0]);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toEqual({
      code: "channel_provider_pending",
      issues: ["whatsapp.cloud"],
      ok: false,
      requestId: REQUEST_ID,
    });
    expect(JSON.stringify(body)).not.toMatch(/route-secret|verify_token|credential/i);
  });
});

describe("WhatsApp Cloud pure inbound contract", () => {
  it("binds message events to both the expected WABA and phone number", async () => {
    const valid = bodyBytes({
      entry: [{
        changes: [{
          field: "messages",
          value: { metadata: { phone_number_id: "phone-001" }, messages: [{ id: "wamid.abc" }] },
        }],
        id: "waba-001",
      }],
      object: "whatsapp_business_account",
    });
    await expect(extractWhatsAppEventDescriptor(valid, "waba-001", "phone-001")).resolves.toEqual({
      action: "message.received",
      eventId: "wamid.abc",
    });
    await expect(extractWhatsAppEventDescriptor(valid, "waba-other", "phone-001")).rejects.toMatchObject({
      code: "channel_tenant_mismatch",
      status: 403,
    });
    await expect(extractWhatsAppEventDescriptor(valid, "waba-001", "phone-other")).rejects.toMatchObject({
      code: "channel_tenant_mismatch",
      status: 403,
    });
  });

  it("permits documented WABA-level events but rejects unknown phone-less changes", async () => {
    const accountUpdate = bodyBytes({
      entry: [{ changes: [{ field: "account_update", value: { event: "PARTNER_APP_INSTALLED" } }], id: "waba-001" }],
      object: "whatsapp_business_account",
    });
    await expect(extractWhatsAppEventDescriptor(accountUpdate, "waba-001", "phone-001")).resolves.toMatchObject({
      action: "event.received",
    });

    const unknown = bodyBytes({
      entry: [{ changes: [{ field: "phone_number_quality_update", value: { quality: "GREEN" } }], id: "waba-001" }],
      object: "whatsapp_business_account",
    });
    await expect(extractWhatsAppEventDescriptor(unknown, "waba-001", "phone-001")).rejects.toMatchObject({
      code: "channel_webhook_invalid",
      status: 400,
    });
  });

  it("keeps a status delivery distinct from the original message receipt", async () => {
    const status = bodyBytes({
      entry: [{
        changes: [{
          field: "messages",
          value: { metadata: { phone_number_id: "phone-001" }, statuses: [{ id: "wamid.abc", status: "delivered" }] },
        }],
        id: "waba-001",
      }],
      object: "whatsapp_business_account",
    });
    await expect(extractWhatsAppEventDescriptor(status, "waba-001", "phone-001")).resolves.toEqual({
      action: "message.status",
      eventId: "status:wamid.abc",
    });
  });
});
