import { describe, expect, it } from "vitest";

import { createTelegramMiniAppCommerceRuntime } from "../../src/lib/channels/telegram-mini-app-commerce";
import { getTelegramMiniAppCatalog } from "../../src/lib/channels/telegram-mini-app-catalog";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { TelegramMiniAppSessionContext } from "../../src/lib/channels/telegram-mini-app-session";

const session = {
  channelConnectionId: null,
  connectorStatus: "active",
  credentialId: "credential",
  credentialVersion: 1,
  customerId: "customer",
  expiresAt: "2026-08-02T01:00:00.000Z",
  identityId: "identity",
  integrationId: "integration",
  issuedAt: "2026-08-02T00:00:00.000Z",
  lastSeenAt: "2026-08-02T00:00:00.000Z",
  sessionId: "session",
  shopId: "shop",
  subjectHash: "subject-hash",
} as TelegramMiniAppSessionContext;

describe("Telegram Mini App commerce boundary", () => {
  it("keeps catalog and commerce provider-pending even if stale active connection data exists", async () => {
    await expect(getTelegramMiniAppCatalog({
      env: {} as AppBindings,
      shopId: "shop",
    })).rejects.toMatchObject({ code: "channel_provider_pending", status: 409 });
    await expect(createTelegramMiniAppCommerceRuntime({
      env: {} as AppBindings,
      idempotencyKey: "telegram-mini-app-test-0002",
      session: { ...session, channelConnectionId: "connection" },
    })).rejects.toMatchObject({ code: "channel_provider_pending", status: 409 });
  });

  it("fails closed when the verified Telegram integration is not linked to a live connection", async () => {
    await expect(createTelegramMiniAppCommerceRuntime({
      env: {} as AppBindings,
      idempotencyKey: "telegram-mini-app-test-0001",
      session,
    })).rejects.toMatchObject({ code: "channel_mini_app_commerce_unavailable", status: 409 });
  });
});
