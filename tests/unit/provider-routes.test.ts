import { describe, expect, it } from "vitest";

import {
  assertProviderConnectionBinding,
  createTelegramMiniAppClaims,
  parseDiscordInteraction,
  readAndVerifyProviderWebhook,
  verifyWhatsAppWebhookChallenge,
} from "../../src/lib/channels/provider-routes";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const BOT_TOKEN = "123456789:mini-app-test-token";
const AUTH_DATE = Math.floor(NOW.getTime() / 1_000) - 60;

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes).buffer, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function initData(): Promise<string> {
  const fields = {
    auth_date: String(AUTH_DATE),
    query_id: "AAE-mini-query",
    start_param: "shop-demo",
    user: JSON.stringify({ first_name: "Buyer", id: 42, language_code: "vi", username: "buyer" }),
  };
  const check = Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT_TOKEN);
  return new URLSearchParams({ ...fields, hash: hex(await hmac(secret, check)) }).toString();
}

async function whatsappSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))}`;
}

describe("provider route contracts", () => {
  it("returns reference-only Telegram Mini App claims and a replay key", async () => {
    const claims = await createTelegramMiniAppClaims({
      botToken: BOT_TOKEN,
      connectionId: "connection-001",
      initData: await initData(),
      now: NOW,
      shopId: "shop-001",
    });
    expect(claims).toMatchObject({
      authDate: new Date(AUTH_DATE * 1_000).toISOString(),
      connectionId: "connection-001",
      providerCode: "telegram.mini_app",
      providerUserId: "42",
      queryId: "AAE-mini-query",
      shopId: "shop-001",
      startParam: "shop-demo",
    });
    expect(claims.initDataHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(claims.replayKey).toContain(claims.initDataHash);
    expect(JSON.stringify(claims)).not.toContain(BOT_TOKEN);
  });

  it("rejects tenant or provider mismatches before a route can claim an event", () => {
    expect(() => {
      assertProviderConnectionBinding({
        actual: { connectionId: "connection-001", providerCode: "discord.bot", shopId: "shop-001" },
        expected: { connectionId: "connection-001", providerCode: "whatsapp.cloud", shopId: "shop-001" },
      });
    }).toThrow(expect.objectContaining({ code: "channel_provider_mismatch", status: 403 }));
    expect(() => {
      assertProviderConnectionBinding({
        actual: { connectionId: "connection-001", providerCode: "discord.bot", shopId: "shop-001" },
        expected: { connectionId: "connection-002", providerCode: "discord.bot", shopId: "shop-001" },
      });
    }).toThrow(expect.objectContaining({ code: "channel_tenant_mismatch", status: 403 }));
  });

  it("validates WhatsApp challenge separately from signed POST bodies", () => {
    expect(verifyWhatsAppWebhookChallenge({
      challenge: "123456789",
      expectedToken: "whatsapp-verify-token",
      mode: "subscribe",
      providedToken: "whatsapp-verify-token",
    })).toBe("123456789");
    expect(() => verifyWhatsAppWebhookChallenge({
      challenge: "123456789",
      expectedToken: "whatsapp-verify-token",
      mode: "subscribe",
      providedToken: "wrong-token-value",
    })).toThrow(expect.objectContaining({ code: "channel_route_invalid", status: 401 }));
    expect(() => verifyWhatsAppWebhookChallenge({
      challenge: "bad\nchallenge",
      expectedToken: "whatsapp-verify-token",
      mode: "subscribe",
      providedToken: "whatsapp-verify-token",
    })).toThrow(expect.objectContaining({ code: "channel_route_invalid" }));
  });

  it("verifies the raw WhatsApp body before normalization", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba-1" }] });
    const signature = await whatsappSignature(body, "app-secret-123456");
    const result = await readAndVerifyProviderWebhook({
      action: "message.received",
      connectionId: "connection-001",
      credentialSecret: "app-secret-123456",
      eventId: "event-001",
      now: NOW,
      providerCode: "whatsapp.cloud",
      request: new Request("https://api.test/webhooks/whatsapp", { body, method: "POST", headers: { "X-Hub-Signature-256": signature } }),
      shopId: "shop-001",
    });
    expect(result.event).toMatchObject({
      action: "message.received",
      channelCode: "whatsapp.cloud",
      connectionId: "connection-001",
      eventId: "event-001",
      shopId: "shop-001",
    });
    expect(new TextDecoder().decode(result.rawBody)).toBe(body);
    await expect(readAndVerifyProviderWebhook({
      action: "message.received",
      connectionId: "connection-001",
      credentialSecret: "app-secret-123456",
      eventId: "event-002",
      now: NOW,
      providerCode: "whatsapp.cloud",
      request: new Request("https://api.test/webhooks/whatsapp", { body: `${body} `, method: "POST", headers: { "X-Hub-Signature-256": signature } }),
      shopId: "shop-001",
    })).rejects.toMatchObject({ code: "channel_webhook_invalid" });
  });

  it("fails closed for Zalo routes until the provider proof is verified", async () => {
    await expect(readAndVerifyProviderWebhook({
      action: "message.received",
      connectionId: "connection-001",
      eventId: "event-zalo-001",
      providerCode: "zalo.mini_app",
      request: new Request("https://api.test/webhooks/zalo", { body: "{}", method: "POST" }),
      shopId: "shop-001",
    })).rejects.toMatchObject({ code: "channel_provider_pending", status: 409 });
  });

  it("only exposes Discord type and safe id after signature verification", () => {
    expect(parseDiscordInteraction(JSON.stringify({ type: 1 }))).toEqual({ kind: "ping", type: 1 });
    expect(parseDiscordInteraction(JSON.stringify({ id: "interaction-001", token: "secret", type: 2 }))).toEqual({
      id: "interaction-001",
      kind: "interaction",
      type: 2,
    });
    expect(() => parseDiscordInteraction(JSON.stringify({ type: "1" }))).toThrow(expect.objectContaining({ code: "channel_route_invalid" }));
    expect(() => parseDiscordInteraction(JSON.stringify({ id: "bad value", type: 2 }))).toThrow(expect.objectContaining({ code: "channel_reference_invalid" }));
  });
});
