import { describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import {
  assertProviderEndpoint,
  createZaloMiniAppAppSecretProof,
  getProviderRuntimeContract,
  listProviderRuntimeContracts,
  normalizeProviderEvent,
  verifyDiscordInteraction,
  verifyProviderWebhook,
  verifyTelegramWebhookSecret,
  verifyZaloMiniAppWebhook,
  verifyWhatsAppCloudWebhook,
} from "../../src/lib/channels/provider-contracts";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("provider runtime contracts", () => {
  it("keeps provider stages explicit and separates Zalo from implemented channels", () => {
    expect(listProviderRuntimeContracts().map((contract) => contract.code)).toEqual([
      "telegram",
      "telegram.mini_app",
      "zalo.mini_app",
      "zalo.oa",
      "whatsapp.cloud",
      "discord.bot",
    ]);
    expect(getProviderRuntimeContract("telegram")).toMatchObject({ inbound: "webhook", stage: "implemented" });
    expect(getProviderRuntimeContract("telegram.mini_app")).toMatchObject({ inbound: "launch_data", replayWindowSeconds: 300, stage: "contract_ready" });
    expect(getProviderRuntimeContract("zalo.mini_app")).toMatchObject({ inbound: "webhook", stage: "provider_pending" });
    expect(getProviderRuntimeContract("whatsapp.cloud")).toMatchObject({ inbound: "webhook", replayWindowSeconds: null, stage: "contract_ready" });
    expect(getProviderRuntimeContract("discord.bot")).toMatchObject({ inbound: "webhook", replayWindowSeconds: 300, stage: "contract_ready" });
  });

  it("allows only the exact HTTPS provider origin", () => {
    expect(assertProviderEndpoint("telegram", "https://api.telegram.org/bot123/getMe").origin).toBe("https://api.telegram.org");
    expect(() => assertProviderEndpoint("telegram", "http://api.telegram.org/bot123/getMe")).toThrow(AppError);
    expect(() => assertProviderEndpoint("telegram", "https://evil.example/bot123/getMe")).toThrow(AppError);
    expect(() => assertProviderEndpoint("zalo.mini_app", "https://openapi.zalo.me/v3.0/miniapp")).toThrow(AppError);
  });

  it("verifies Telegram secret headers before a webhook body is trusted", () => {
    expect(() => { verifyTelegramWebhookSecret({ expected: "secret-token-123", provided: "secret-token-123" }); }).not.toThrow();
    expect(() => { verifyTelegramWebhookSecret({ expected: "a", provided: "a" }); }).not.toThrow();
    expect(() => { verifyTelegramWebhookSecret({ expected: "secret-token-123", provided: "wrong-token-123" }); }).toThrow(AppError);
    expect(() => { verifyTelegramWebhookSecret({ expected: "secret-token-123", provided: null }); }).toThrow(AppError);
    expect(() => { verifyTelegramWebhookSecret({ expected: "secret-token-123", provided: "secret token" }); }).toThrow(AppError);
  });

  it("verifies WhatsApp HMAC over the raw body", async () => {
    const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-1" }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("app-secret-123456"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
    const signature = `sha256=${hex(digest)}`;
    await expect(verifyWhatsAppCloudWebhook({ appSecret: "app-secret-123456", rawBody, signature })).resolves.toBeUndefined();
    await expectCode(verifyWhatsAppCloudWebhook({ appSecret: "app-secret-123456", rawBody: `${rawBody} `, signature }), "channel_webhook_invalid");
    await expectCode(verifyProviderWebhook({ code: "zalo.mini_app", rawBody, signature }), "channel_provider_pending");
  });

  it("matches the official Zalo Mini App parsed-event signature algorithm", async () => {
    const body = JSON.stringify({ timestamp: 1670553442564, appId: "app-1", event: "user.revoke.consent", userId: "user-1" });
    const apiKey = "zalo-mini-app-api-key-1234";
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const content = Object.keys(parsed).sort().map((key) => {
      const value = parsed[key];
      return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    }).join("");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${content}${apiKey}`)));
    const signature = hex(digest);
    await expect(verifyZaloMiniAppWebhook({ apiKey, rawBody: body, signature })).resolves.toBeUndefined();
    await expectCode(verifyZaloMiniAppWebhook({ apiKey, rawBody: body.replace("user-1", "user-2"), signature }), "channel_webhook_invalid");
  });

  it("computes the server-side Zalo appsecret_proof input", async () => {
    const proof = await createZaloMiniAppAppSecretProof({
      accessToken: "zalo-access-token",
      appSecret: "zalo-app-secret-1234",
    });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("zalo-app-secret-1234"), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const expected = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("zalo-access-token"))));
    expect(proof).toBe(expected);
  });

  it("verifies Discord Ed25519 interactions with a bounded replay window", async () => {
    const generated = await crypto.subtle.generateKey({ name: "Ed25519", namedCurve: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", generated.publicKey));
    const timestamp = String(Math.floor(NOW.getTime() / 1_000));
    const rawBody = JSON.stringify({ type: 1 });
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", generated.privateKey, new TextEncoder().encode(`${timestamp}${rawBody}`)));
    await expect(verifyDiscordInteraction({ now: NOW, publicKeyHex: hex(publicKey), rawBody, signatureHex: hex(signature), timestamp })).resolves.toBeUndefined();
    await expectCode(verifyDiscordInteraction({ now: NOW, publicKeyHex: hex(publicKey), rawBody: `${rawBody} `, signatureHex: hex(signature), timestamp }), "channel_webhook_invalid");
    await expectCode(verifyDiscordInteraction({ now: NOW, publicKeyHex: hex(publicKey), rawBody, signatureHex: hex(signature), timestamp: String(Number(timestamp) - 301) }), "channel_webhook_replay");
  });

  it("normalizes only safe references and never retains provider payloads", async () => {
    const event = await normalizeProviderEvent({
      action: "message.received",
      connectionId: "connection-001",
      eventId: "1",
      providerCode: "discord.bot",
      rawBody: "{\"content\":\"secret\"}",
      receivedAt: NOW,
      shopId: "shop-001",
    });
    expect(event).toMatchObject({
      action: "message.received",
      channelCode: "discord.bot",
      connectionId: "connection-001",
      eventId: "1",
      idempotencyKey: "discord.bot:1",
      receivedAt: NOW.toISOString(),
      shopId: "shop-001",
    });
    expect(event.payloadReference).not.toContain("secret");
    await expectCode(normalizeProviderEvent({
      action: "message.received",
      connectionId: "connection-001",
      eventId: "123456790",
      providerCode: "discord.bot",
      rawBody: new Uint8Array(512 * 1024 + 1),
      shopId: "shop-001",
    }), "channel_webhook_body_too_large");
    await expectCode(normalizeProviderEvent({
      action: "message.received",
      connectionId: "connection-001",
      eventId: "123456789",
      providerCode: "zalo.mini_app",
      rawBody: "{}",
      shopId: "shop-001",
    }), "channel_provider_pending");
  });
});
