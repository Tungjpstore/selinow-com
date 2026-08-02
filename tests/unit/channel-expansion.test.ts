import { describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import {
  CHANNEL_EXPANSION_CATALOG,
  DISCORD_BOT_CHANNEL_CODE,
  platformChannelRegistry,
  TELEGRAM_MINI_APP_CHANNEL_CODE,
  WHATSAPP_CLOUD_CHANNEL_CODE,
  ZALO_MINI_APP_CHANNEL_CODE,
} from "../../src/lib/channels/expansion";
import { verifyTelegramMiniAppInitData } from "../../src/lib/channels/mini-app";
import { decideOutboundMessagePolicy } from "../../src/lib/channels/messaging-policy";

const BOT_TOKEN = "123456789:mini-app-test-token";
const AUTH_DATE = 1_780_000_000;

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes).buffer, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tamperHash(value: string): string {
  const params = new URLSearchParams(value);
  const hash = params.get("hash") ?? "";
  params.set("hash", `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`);
  return params.toString();
}

async function initData(overrides: Record<string, string> = {}): Promise<string> {
  const fields = {
    auth_date: String(AUTH_DATE),
    query_id: "AAE-mini-query",
    start_param: "shop-demo",
    user: JSON.stringify({ first_name: "Buyer", id: 42, language_code: "vi", username: "buyer" }),
    ...overrides,
  };
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT_TOKEN);
  const hash = hex(await hmac(secret, dataCheckString));
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("channel expansion contracts", () => {
  it("keeps expansion manifests explicit and out of the active commerce registry", () => {
    expect(CHANNEL_EXPANSION_CATALOG.map((entry) => entry.code)).toEqual([
      TELEGRAM_MINI_APP_CHANNEL_CODE,
      ZALO_MINI_APP_CHANNEL_CODE,
      WHATSAPP_CLOUD_CHANNEL_CODE,
      DISCORD_BOT_CHANNEL_CODE,
    ]);
    expect(platformChannelRegistry.require(WHATSAPP_CLOUD_CHANNEL_CODE).capabilities).toContain("message.template_outside_window");
    expect(CHANNEL_EXPANSION_CATALOG.map((entry) => entry.inlineSecretDelivery)).toEqual([false, false, false, false]);
  });

  it("enforces WhatsApp windows and keeps secrets on authorized reveal paths", () => {
    expect(decideOutboundMessagePolicy({
      conversationWindowExpiresAt: "2026-08-02T05:00:00.000Z",
      isSecret: false,
      providerCode: WHATSAPP_CLOUD_CHANNEL_CODE,
      recipientScope: "direct",
      now: new Date("2026-08-02T04:30:00.000Z"),
    })).toEqual({ requiresTemplate: false, safeMode: "normal" });
    expect(decideOutboundMessagePolicy({
      conversationWindowExpiresAt: "2026-08-02T04:00:00.000Z",
      isSecret: false,
      providerCode: WHATSAPP_CLOUD_CHANNEL_CODE,
      recipientScope: "direct",
      templateName: "order_ready",
      now: new Date("2026-08-02T05:00:00.000Z"),
    })).toEqual({ requiresTemplate: true, safeMode: "template" });
    expect(decideOutboundMessagePolicy({
      isSecret: true,
      providerCode: DISCORD_BOT_CHANNEL_CODE,
      recipientScope: "direct",
    })).toEqual({ requiresTemplate: false, safeMode: "authorized_reveal" });
    expect(() => decideOutboundMessagePolicy({
      isSecret: false,
      providerCode: WHATSAPP_CLOUD_CHANNEL_CODE,
      recipientScope: "group",
    })).toThrow(expect.objectContaining({ code: "channel_recipient_scope_invalid" }));
    expect(() => decideOutboundMessagePolicy({
      isSecret: false,
      providerCode: WHATSAPP_CLOUD_CHANNEL_CODE,
      recipientScope: "direct",
    })).toThrow(expect.objectContaining({ code: "channel_template_required" }));
    expect(decideOutboundMessagePolicy({
      conversationWindowExpiresAt: "2026-08-02T04:00:00.000Z",
      isSecret: true,
      providerCode: WHATSAPP_CLOUD_CHANNEL_CODE,
      recipientScope: "private",
      now: new Date("2026-08-02T05:00:00.000Z"),
    })).toEqual({ requiresTemplate: false, safeMode: "authorized_reveal" });
    expect(() => decideOutboundMessagePolicy({
      conversationWindowExpiresAt: "not-a-timestamp",
      isSecret: false,
      providerCode: WHATSAPP_CLOUD_CHANNEL_CODE,
      recipientScope: "direct",
      templateName: "order_ready",
    })).toThrow(expect.objectContaining({ code: "validation_failed" }));
    expect(() => decideOutboundMessagePolicy({
      isSecret: true,
      providerCode: DISCORD_BOT_CHANNEL_CODE,
      recipientScope: "group",
    })).toThrow(expect.objectContaining({ code: "channel_secret_delivery_forbidden" }));
  });

  it("verifies Telegram Mini App initData with freshness and tamper checks", async () => {
    const now = new Date((AUTH_DATE + 60) * 1000);
    const launch = await verifyTelegramMiniAppInitData({ botToken: BOT_TOKEN, initData: await initData(), now });
    expect(launch).toMatchObject({ queryId: "AAE-mini-query", startParam: "shop-demo", user: { id: "42", firstName: "Buyer", languageCode: "vi" } });
    const tampered = await initData({ start_param: "other-shop" });
    await expect(verifyTelegramMiniAppInitData({ botToken: BOT_TOKEN, initData: tamperHash(tampered), now })).rejects.toMatchObject({ code: "telegram_mini_app_invalid" });
    await expect(verifyTelegramMiniAppInitData({ botToken: BOT_TOKEN, initData: await initData({ auth_date: String(AUTH_DATE - 100_000) }), now })).rejects.toMatchObject({ code: "telegram_mini_app_expired" });
    await expect(verifyTelegramMiniAppInitData({ botToken: BOT_TOKEN, initData: "auth_date=1&hash=bad" })).rejects.toBeInstanceOf(AppError);
    await expect(verifyTelegramMiniAppInitData({ botToken: BOT_TOKEN, initData: `${await initData()}&auth_date=${String(AUTH_DATE)}`, now })).rejects.toMatchObject({ code: "telegram_mini_app_invalid" });
    await expect(verifyTelegramMiniAppInitData({ botToken: BOT_TOKEN, initData: await initData({ auth_date: String(AUTH_DATE + 1_000) }), now })).rejects.toMatchObject({ code: "telegram_mini_app_expired" });
    await expect(verifyTelegramMiniAppInitData({ botToken: BOT_TOKEN, initData: await initData({ user: JSON.stringify({ id: 42 }) }), now })).rejects.toMatchObject({ code: "telegram_mini_app_invalid" });
    await expect(verifyTelegramMiniAppInitData({ botToken: BOT_TOKEN, initData: await initData({ user: JSON.stringify({ first_name: "Buyer", id: 42, username: "x\u0000y" }) }), now })).rejects.toMatchObject({ code: "telegram_mini_app_invalid" });
  });
});
