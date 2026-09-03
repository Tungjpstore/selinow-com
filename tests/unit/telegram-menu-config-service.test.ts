import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getShopForMember: vi.fn(),
  loadActiveTelegramCredential: vi.fn(),
  setChatMenuButton: vi.fn(),
}));

vi.mock("../../src/lib/tenants/store", () => ({
  getShopForMember: dependencies.getShopForMember,
}));

vi.mock("../../src/lib/telegram/credentials", () => ({
  loadActiveTelegramCredential: dependencies.loadActiveTelegramCredential,
}));

vi.mock("../../src/lib/telegram/client", () => ({
  TelegramClient: class {
    setChatMenuButton = dependencies.setChatMenuButton;
  },
}));

import type { AppError } from "../../src/lib/core/errors";
import { updateTelegramMenuConfig } from "../../src/lib/telegram/integrations";

type RecordedStatement = { sql: string; values: unknown[]; meta: { changes: number } };

function fakeEnv(options: { updateChanges?: number; hostname?: string | null; integrationStatus?: string } = {}) {
  const statements: RecordedStatement[] = [];
  const updateChanges = options.updateChanges ?? 1;
  const state = { templatePreset: "license_vault" };
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const record: RecordedStatement = { sql, values, meta: { changes: updateChanges } };
          statements.push(record);
          return {
            run: () => {
              if (sql.includes("SET template_preset")) state.templatePreset = String(values[0]);
              return Promise.resolve({ meta: record.meta });
            },
            first: () => {
              if (sql.includes("SELECT domain.hostname_normalized")) {
                return Promise.resolve(options.hostname === undefined ? null : { hostname: options.hostname });
              }
              if (sql.includes("FROM telegram_integrations WHERE shop_id = ?")) {
                return Promise.resolve({ ...integrationRow(), status: options.integrationStatus ?? "active", templatePreset: state.templatePreset });
              }
              return Promise.resolve(null);
            },
            all: () => Promise.resolve({ results: [] }),
          };
        },
      };
    },
    batch: (items: unknown[]) => Promise.resolve(items.map(() => ({ meta: { changes: 1 } }))),
  };
  return { env: { PLATFORM_DB: database } as never, statements };
}

function integrationRow() {
  return {
    id: "tin-1",
    publicId: "tgint-1",
    webhookPublicId: "tgwh-1",
    shopId: "shop-1",
    status: "active",
    webhookStatus: "verified",
    activeCredentialId: "tc-1",
    channelConnectionId: null,
    connectedAt: "2026-01-01T00:00:00.000Z",
    botId: "100",
    botUsername: "shop_bot",
    botDisplayName: "Shop Bot",
    templatePreset: "license_vault",
    welcomeMessageCustom: null,
    supportHandle: null,
    menuConfigJson: null,
    generationState: "active",
    integrationGeneration: 1,
    lastCheckedAt: null,
    lastHealthUpdateAt: null,
    lastOutboundAt: null,
    lastSafeErrorCode: null,
    lastUpdateAt: null,
    pendingUpdateCount: 0,
  };
}

function membership() {
  return {
    row: { shop_id: "shop-1", role: "owner", shop_status: "active" },
    shop: { defaultLocale: "vi-VN", featureFlags: { telegram: true } },
  } as never;
}

const baseInput = {
  requestId: "req-menu-config",
  shopPublicId: "shop_public_1",
  userId: "user-1",
  templatePreset: "gaming_topup" as const,
};

describe("updateTelegramMenuConfig", () => {
  beforeEach(() => {
    dependencies.getShopForMember.mockReset().mockResolvedValue(membership());
    dependencies.loadActiveTelegramCredential.mockReset().mockResolvedValue({ credentials: { botToken: "bot-token" } });
    dependencies.setChatMenuButton.mockReset().mockResolvedValue(undefined);
  });

  it("saves the preset with full generation fencing for an active bot", async () => {
    const { env, statements } = fakeEnv();
    await updateTelegramMenuConfig({ ...baseInput, env, welcomeMessageCustom: " Chào {shop} ", supportHandle: "@admin_shop" });

    const update = statements.find((statement) => statement.sql.includes("SET template_preset"));
    expect(update).toBeDefined();
    const sql = (update as RecordedStatement).sql;
    expect(sql).toContain("shop_id = ?");
    expect(sql).toContain("generation_state = 'active'");
    expect(sql).toContain("status IN ('pending', 'active', 'degraded')");
    expect((update as RecordedStatement).values).toEqual(expect.arrayContaining(["gaming_topup", "Chào {shop}", "@admin_shop"]));
  });

  it("pushes the commands menu button for non-mini-app presets", async () => {
    const { env } = fakeEnv();
    await updateTelegramMenuConfig({ ...baseInput, env });
    expect(dependencies.setChatMenuButton).toHaveBeenCalledWith({ type: "commands" });
  });

  it("points the web_app menu button at the shop's own storefront hostname", async () => {
    const { env } = fakeEnv({ hostname: "myshop.example" });
    await updateTelegramMenuConfig({ ...baseInput, env, templatePreset: "mini_app_hybrid" });

    expect(dependencies.setChatMenuButton).toHaveBeenCalledWith({
      text: "Cửa hàng",
      type: "web_app",
      web_app: { url: "https://myshop.example" },
    });
  });

  it("records a safe health code when Telegram rejects the menu sync", async () => {
    const { env, statements } = fakeEnv();
    dependencies.setChatMenuButton.mockRejectedValue(new Error("provider down"));

    const view = await updateTelegramMenuConfig({ ...baseInput, env });
    expect(view.templatePreset).toBe("gaming_topup");

    const health = statements.find((statement) => statement.sql.includes("telegram_menu_update_failed"));
    const audit = statements.find((statement) => statement.sql.includes("telegram.menu_sync_failed"));
    expect(health).toBeDefined();
    expect(audit).toBeDefined();
  });

  it("fails closed when a concurrent lifecycle change wins the fenced update", async () => {
    const { env } = fakeEnv({ updateChanges: 0 });
    await expect(updateTelegramMenuConfig({ ...baseInput, env })).rejects.toMatchObject({
      code: "telegram_integration_busy",
      status: 409,
    } satisfies Partial<AppError>);
    expect(dependencies.setChatMenuButton).not.toHaveBeenCalled();
  });

  it("rejects malformed support handles and menu config JSON", async () => {
    const { env, statements } = fakeEnv();
    await expect(updateTelegramMenuConfig({ ...baseInput, env, supportHandle: "admin shop" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(updateTelegramMenuConfig({ ...baseInput, env, menuConfigJson: "{not-json" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(updateTelegramMenuConfig({ ...baseInput, env, menuConfigJson: '{"rogueKey":1}' })).rejects.toMatchObject({ code: "validation_failed" });
    expect(statements.find((statement) => statement.sql.includes("SET template_preset"))).toBeUndefined();
  });

  it("skips the provider sync while the integration is still pending", async () => {
    const { env } = fakeEnv({ integrationStatus: "pending" });
    await updateTelegramMenuConfig({ ...baseInput, env });
    expect(dependencies.loadActiveTelegramCredential).not.toHaveBeenCalled();
    expect(dependencies.setChatMenuButton).not.toHaveBeenCalled();
  });
});
