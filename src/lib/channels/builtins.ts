import { ChannelAdapterRegistry } from "./registry";
import type { ChannelAdapterManifest } from "./types";

export const WEBSITE_CHANNEL_CODE = "website";
export const TELEGRAM_CHANNEL_CODE = "telegram";

export type BuiltInCommerceChannelCode = typeof TELEGRAM_CHANNEL_CODE | typeof WEBSITE_CHANNEL_CODE;

export const BUILT_IN_CHANNEL_MANIFESTS = [
  {
    capabilities: [
      "catalog.read",
      "cart.interactive",
      "checkout.external_link",
      "fulfillment.inline_secret",
      "identity.private",
    ],
    code: WEBSITE_CHANNEL_CODE,
    version: 1,
  },
  {
    capabilities: [
      "conversation.inbound",
      "conversation.outbound",
      "message.rich_ui",
      "catalog.read",
      "cart.interactive",
      "checkout.external_link",
      "fulfillment.inline_secret",
      "identity.private",
    ],
    code: TELEGRAM_CHANNEL_CODE,
    version: 1,
  },
] as const satisfies readonly ChannelAdapterManifest[];

export const builtInChannelRegistry = new ChannelAdapterRegistry(BUILT_IN_CHANNEL_MANIFESTS);
