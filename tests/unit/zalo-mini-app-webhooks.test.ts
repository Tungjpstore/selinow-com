import { describe, expect, it, vi } from "vitest";

import { toBase64Url } from "../../src/lib/core/ids";
import { encryptZaloMiniAppCredential } from "../../src/lib/channels/zalo-mini-app-credentials";
import { processZaloMiniAppWebhook } from "../../src/lib/channels/zalo-mini-app-webhooks";

const KEY = toBase64Url(new Uint8Array(32).fill(9));
const ROW_CONTEXT = {
  connectionId: "connection-001",
  credentialId: "credential-001",
  keyVersion: "v1",
  shopId: "shop-001",
};

async function runtime() {
  const envelope = await encryptZaloMiniAppCredential({
    ...ROW_CONTEXT,
    apiKey: "zalo-mini-app-api-key-1234",
    appId: "zalo-app-001",
    hmacSecret: "identifier-hmac-secret",
    kek: KEY,
  });
  const row = {
    ...ROW_CONTEXT,
    ...envelope,
    connectionPublicId: "channel-00000000-0000-4000-8000-000000000001",
    connectionStatus: "active",
    channelCode: "zalo.mini_app",
    channelStatus: "enabled",
    shopPublicId: "shop-public-001",
    shopStatus: "active",
    subscriptionState: "active",
    credentialKeyVersion: envelope.keyVersion,
    credentialStatus: "active",
    credentialVersion: 1,
    providerCode: "zalo.mini_app" as const,
  };
  const prepare = vi.fn(() => ({
    bind: () => ({ first: () => Promise.resolve(row) }),
  }));
  return {
    env: { CREDENTIAL_KEK_V1: KEY, PLATFORM_DB: { prepare } },
    prepare,
  };
}

describe("Zalo Mini App webhook route service", () => {
  it("rejects before tenant/credential lookup and body consumption while provider admission is pending", async () => {
    const runtimeState = await runtime();
    const request = new Request("https://api.test/webhooks/zalo", {
      body: JSON.stringify({ appId: "zalo-app-001", event: "user.revoke.consent", timestamp: 1, userId: "user-1" }),
      headers: { "Content-Type": "application/json", "X-ZEvent-Signature": "invalid" },
      method: "POST",
    });
    await expect(processZaloMiniAppWebhook({
      connectionPublicId: "channel-00000000-0000-4000-8000-000000000001",
      env: runtimeState.env as never,
      request,
    })).rejects.toMatchObject({ code: "channel_provider_pending", status: 409 });
    expect(request.bodyUsed).toBe(false);
    // Provider-pending admission is rejected before tenant/credential lookup,
    // so a malformed or missing local envelope cannot turn this edge into a
    // decryption error or cause an unneeded D1 claim.
    expect(runtimeState.prepare).not.toHaveBeenCalled();
  });

  it("rejects malformed public IDs before touching D1", async () => {
    const runtimeState = await runtime();
    await expect(processZaloMiniAppWebhook({
      connectionPublicId: "bad id",
      env: runtimeState.env as never,
      request: new Request("https://api.test/webhooks/zalo", { method: "POST" }),
    })).rejects.toMatchObject({ code: "webhook_not_found", status: 404 });
    expect(runtimeState.prepare).not.toHaveBeenCalled();
  });
});
