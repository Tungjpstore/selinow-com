import { describe, expect, it } from "vitest";

import { TelegramClient } from "../../src/lib/telegram/client";

const TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDE";

describe("Telegram Bot API client", () => {
  it("invokes the fetch dependency without rebinding its receiver", async () => {
    const fetcher = function (this: unknown): Promise<Response> {
      expect(this).toBeUndefined();
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { first_name: "Test Bot", id: 123_456_789, is_bot: true, username: "test_shop_bot" } }), { status: 200 }));
    } as typeof fetch;

    await expect(new TelegramClient(TOKEN, fetcher).getMe()).resolves.toMatchObject({ id: "123456789" });
  });

  it("uses the fixed Telegram API origin and parses getMe identity", async () => {
    const fetcher: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(url.startsWith("https://api.telegram.org/bot")).toBe(true);
      expect(url.endsWith("/getMe")).toBe(true);
      expect(init?.method).toBe("POST");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { first_name: "Test Bot", id: 123_456_789, is_bot: true, username: "test_shop_bot" } }), { status: 200 }));
    };

    await expect(new TelegramClient(TOKEN, fetcher).getMe()).resolves.toEqual({ displayName: "Test Bot", id: "123456789", username: "test_shop_bot" });
  });

  it("sets a URL-safe secret, bounded allowed updates and explicit connection limit", async () => {
    const fetcher: typeof fetch = (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      expect(body).toMatchObject({
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
        max_connections: 20,
        secret_token: "safe_secret-token_123",
        url: "https://api.example.test/webhooks/telegram/tgwh_test",
      });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    };

    await expect(new TelegramClient(TOKEN, fetcher).setWebhook({ allowedUpdates: ["message", "callback_query"], maxConnections: 20, secretToken: "safe_secret-token_123", url: "https://api.example.test/webhooks/telegram/tgwh_test" })).resolves.toBeUndefined();
  });

  it("preserves Telegram retry_after without exposing provider descriptions", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ description: "sensitive provider text", error_code: 429, ok: false, parameters: { retry_after: 17 } }), { status: 429 }));
    const request = new TelegramClient(TOKEN, fetcher).getMe();
    await expect(request).rejects.toMatchObject({ code: "telegram_rate_limited", retryAfter: 17 });
    await expect(request).rejects.not.toMatchObject({ message: "sensitive provider text" });
  });
});
