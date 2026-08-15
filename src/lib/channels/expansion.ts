import { AppError } from "../core/errors";
import { builtInChannelRegistry } from "./builtins";
import { ChannelAdapterRegistry } from "./registry";
import type { ChannelAdapterManifest, ChannelCapability } from "./types";

export const TELEGRAM_MINI_APP_CHANNEL_CODE = "telegram.mini_app";
export const ZALO_MINI_APP_CHANNEL_CODE = "zalo.mini_app";
export const ZALO_OFFICIAL_ACCOUNT_CHANNEL_CODE = "zalo.oa";
export const WHATSAPP_CLOUD_CHANNEL_CODE = "whatsapp.cloud";
export const DISCORD_BOT_CHANNEL_CODE = "discord.bot";

export type ChannelExpansionStage = "contract_ready" | "provider_pending";
export type ChannelExpansionFamily = "discord_bot" | "telegram_mini_app" | "whatsapp_bot" | "zalo_mini_app" | "zalo_official_account";

export type ChannelExpansionCatalogEntry = {
  capabilities: readonly ChannelCapability[];
  code: string;
  family: ChannelExpansionFamily;
  inlineSecretDelivery: false;
  providerCode: string;
  providerExecution: ChannelExpansionStage;
  requiredSellerAction: "connect_provider" | "create_app" | "create_bot";
  safeDescriptionKey: string;
  version: number;
};

const expansionEntries = [
  {
    capabilities: [
      "catalog.read",
      "cart.interactive",
      "checkout.external_link",
      "identity.private",
      "message.rich_ui",
    ],
    code: TELEGRAM_MINI_APP_CHANNEL_CODE,
    family: "telegram_mini_app",
    inlineSecretDelivery: false,
    providerCode: TELEGRAM_MINI_APP_CHANNEL_CODE,
    providerExecution: "provider_pending",
    requiredSellerAction: "create_bot",
    safeDescriptionKey: "dashboard.channels.expansion.telegram_mini_app",
    version: 1,
  },
  {
    capabilities: [
      "conversation.inbound",
      "conversation.outbound",
      "identity.private",
      "message.rich_ui",
      "orders.status_push",
    ],
    code: ZALO_OFFICIAL_ACCOUNT_CHANNEL_CODE,
    family: "zalo_official_account",
    inlineSecretDelivery: false,
    providerCode: ZALO_OFFICIAL_ACCOUNT_CHANNEL_CODE,
    providerExecution: "provider_pending",
    requiredSellerAction: "connect_provider",
    safeDescriptionKey: "dashboard.channels.expansion.zalo_oa",
    version: 1,
  },
  {
    capabilities: [
      "catalog.read",
      "cart.interactive",
      "checkout.external_link",
      "identity.private",
      "message.rich_ui",
    ],
    code: ZALO_MINI_APP_CHANNEL_CODE,
    family: "zalo_mini_app",
    inlineSecretDelivery: false,
    providerCode: ZALO_MINI_APP_CHANNEL_CODE,
    providerExecution: "provider_pending",
    requiredSellerAction: "create_app",
    safeDescriptionKey: "dashboard.channels.expansion.zalo_mini_app",
    version: 1,
  },
  {
    capabilities: [
      "catalog.read",
      "cart.interactive",
      "checkout.external_link",
      "conversation.inbound",
      "conversation.outbound",
      "identity.private",
      "message.template_outside_window",
      "message.rich_ui",
      "orders.status_push",
    ],
    code: WHATSAPP_CLOUD_CHANNEL_CODE,
    family: "whatsapp_bot",
    inlineSecretDelivery: false,
    providerCode: WHATSAPP_CLOUD_CHANNEL_CODE,
    providerExecution: "provider_pending",
    requiredSellerAction: "connect_provider",
    safeDescriptionKey: "dashboard.channels.expansion.whatsapp_cloud",
    version: 1,
  },
  {
    capabilities: [
      "catalog.read",
      "checkout.external_link",
      "conversation.inbound",
      "conversation.outbound",
      "identity.private",
      "message.rich_ui",
      "orders.status_push",
    ],
    code: DISCORD_BOT_CHANNEL_CODE,
    family: "discord_bot",
    inlineSecretDelivery: false,
    providerCode: DISCORD_BOT_CHANNEL_CODE,
    providerExecution: "provider_pending",
    requiredSellerAction: "create_bot",
    safeDescriptionKey: "dashboard.channels.expansion.discord_bot",
    version: 1,
  },
] as const satisfies readonly ChannelExpansionCatalogEntry[];

export const CHANNEL_EXPANSION_CATALOG: readonly ChannelExpansionCatalogEntry[] = Object.freeze(
  expansionEntries.map((entry) => Object.freeze({
    ...entry,
    capabilities: Object.freeze([...entry.capabilities]),
  })),
);

export const PLATFORM_CHANNEL_MANIFESTS: readonly ChannelAdapterManifest[] = Object.freeze([
  ...builtInChannelRegistry.list(),
  ...CHANNEL_EXPANSION_CATALOG.map((entry) => ({
    capabilities: entry.capabilities,
    code: entry.code,
    version: entry.version,
  })),
]);

export const platformChannelRegistry = new ChannelAdapterRegistry(PLATFORM_CHANNEL_MANIFESTS);

export function listChannelExpansionCatalog(): readonly ChannelExpansionCatalogEntry[] {
  return CHANNEL_EXPANSION_CATALOG;
}

export function requireChannelExpansion(code: string): ChannelExpansionCatalogEntry {
  const entry = CHANNEL_EXPANSION_CATALOG.find((candidate) => candidate.code === code);
  if (entry === undefined) throw new AppError("channel_adapter_unknown", 404);
  return entry;
}

export function isChannelCatalogPublishingAllowed(code: string): boolean {
  const expansion = CHANNEL_EXPANSION_CATALOG.find((candidate) => candidate.code === code);
  if (expansion !== undefined) return false;
  return builtInChannelRegistry.get(code) !== null;
}

export function isChannelSellerActivationAllowed(code: string): boolean {
  return isChannelCatalogPublishingAllowed(code);
}

export function assertChannelProviderExecutionReady(code: string): void {
  const expansion = CHANNEL_EXPANSION_CATALOG.find((candidate) => candidate.code === code);
  if (expansion === undefined) {
    if (builtInChannelRegistry.get(code) === null) throw new AppError("channel_adapter_unknown", 404);
    return;
  }
  throw new AppError("channel_provider_pending", 409, [expansion.code]);
}

export function assertExpansionProviderPending(code: string): never {
  const entry = requireChannelExpansion(code);
  throw new AppError("channel_provider_pending", 409, [entry.code]);
}
