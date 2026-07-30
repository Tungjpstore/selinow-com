import { beforeEach, describe, expect, it, vi } from "vitest";

const credentialMocks = vi.hoisted(() => ({
  decryptRecipient: vi.fn(),
  loadCredential: vi.fn(),
}));

vi.mock("../../src/lib/telegram/credentials", () => ({
  decryptTelegramRecipientRow: credentialMocks.decryptRecipient,
  loadActiveTelegramCredential: credentialMocks.loadCredential,
}));

import type { AppBindings } from "../../src/lib/platform/bindings";
import { processTelegramOutbox } from "../../src/lib/telegram/outbox";

function runtime(
  identityLocale: string | null,
  shopDefaultLocale: string,
  orderLocale: string | null = null,
  connectionIds: { attribution: string; integration: string } = { attribution: "connection-1", integration: "connection-1" },
  preferredLocale: string | null = null,
): AppBindings {
  const database = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            all() {
              if (!sql.includes("FROM outbox_jobs")) throw new Error("unexpected_all_query");
              return Promise.resolve({ results: [{ attempts: 0, id: "job-1", orderId: "order-internal-1", shopId: "shop-1" }] });
            },
            first() {
              if (!sql.includes("FROM orders")) throw new Error("unexpected_first_query");
              return Promise.resolve({
                attributionChannelCode: "telegram",
                attributionConnectionId: connectionIds.attribution,
                chatIdCiphertextB64: "ciphertext",
                chatIdIvB64: "iv",
                customerIdentityId: "identity-1",
                identityLocale,
                integrationConnectionId: connectionIds.integration,
                orderLocale,
                integrationId: "integration-1",
                keyVersion: "v1",
                orderNumber: "ORDER-1",
                orderPublicId: "order-public-1",
                preferredLocale,
                recipientId: "recipient-1",
                shopDefaultLocale,
                sourceChannel: "telegram",
              });
            },
            run: () => Promise.resolve({ meta: { changes: 1 } }),
          };
        },
      };
    },
    batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return { PLATFORM_DB: database } as unknown as AppBindings;
}

beforeEach(() => {
  credentialMocks.loadCredential.mockReset().mockResolvedValue({ credentials: { botToken: "123456789:token", webhookSecret: "secret" }, row: {} });
  credentialMocks.decryptRecipient.mockReset().mockResolvedValue("42");
});

describe("Telegram outbox localization", () => {
  it.each([
    ["en-US", "vi", "Order ORDER-1 is paid and ready for delivery.", "View key"],
    ["fr-FR", "vi", "Đơn ORDER-1 đã thanh toán và sẵn sàng giao.", "Xem key"],
  ])("uses identity locale %s with shop fallback %s", async (identityLocale, shopDefaultLocale, expectedText, expectedButton) => {
    const fetcher: typeof fetch = (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> }; text?: string };
      expect(body.text).toContain(expectedText);
      expect(body.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe(expectedButton);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    };

    await expect(processTelegramOutbox(runtime(identityLocale, shopDefaultLocale), new Date("2026-07-29T00:00:00.000Z"), fetcher)).resolves.toEqual({ failed: 0, processed: 1, skipped: 0 });
  });

  it("uses the verified identity locale before the order request snapshot", async () => {
    const fetcher: typeof fetch = (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { text?: string; reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> } };
      expect(body.text).toContain("Order ORDER-1 is paid");
      expect(body.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe("View key");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    };

    await expect(processTelegramOutbox(runtime("en", "en", "vi-VN"), new Date("2026-07-29T00:00:00.000Z"), fetcher)).resolves.toEqual({ failed: 0, processed: 1, skipped: 0 });
  });

  it("uses the durable buyer preference before identity and order locale", async () => {
    const fetcher: typeof fetch = (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { text?: string };
      expect(body.text).toContain("Đơn ORDER-1 đã thanh toán");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    };

    await expect(processTelegramOutbox(
      runtime("en", "en", "en", { attribution: "connection-1", integration: "connection-1" }, "vi-VN"),
      new Date("2026-07-29T00:00:00.000Z"),
      fetcher,
    )).resolves.toEqual({ failed: 0, processed: 1, skipped: 0 });
  });

  it("does not reroute a legacy outbox notification through a different Telegram connection", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(processTelegramOutbox(
      runtime("en", "en", null, { attribution: "connection-original", integration: "connection-replacement" }),
      new Date("2026-07-29T00:00:00.000Z"),
      fetcher,
    )).resolves.toEqual({ failed: 0, processed: 0, skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
