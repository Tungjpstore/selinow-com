import {
  builtInChannelRegistry,
  TELEGRAM_CHANNEL_CODE,
  WEBSITE_CHANNEL_CODE,
  type BuiltInCommerceChannelCode,
} from "./builtins";

type LegacyOrderSourceChannel = "telegram" | "web";

export type { LegacyOrderSourceChannel };

export type OrderChannelAttribution = {
  adapterVersion: number;
  channelCode: string;
  legacySourceChannel: LegacyOrderSourceChannel;
};

const LEGACY_SOURCE_CHANNELS: Readonly<Record<BuiltInCommerceChannelCode, LegacyOrderSourceChannel>> = {
  [TELEGRAM_CHANNEL_CODE]: "telegram",
  [WEBSITE_CHANNEL_CODE]: "web",
};

export function resolveOrderChannelAttribution(channelCode: BuiltInCommerceChannelCode): OrderChannelAttribution {
  const manifest = builtInChannelRegistry.require(channelCode);
  const legacySourceChannel = LEGACY_SOURCE_CHANNELS[channelCode];
  return { adapterVersion: manifest.version, channelCode, legacySourceChannel };
}

/**
 * Resolve attribution for an adapter outside the built-in website/Telegram
 * registry. The legacy source bucket stays explicit for compatibility with
 * the existing carts/orders CHECK constraints.
 */
export function resolveExternalOrderChannelAttribution(input: {
  adapterVersion: number;
  channelCode: string;
  legacySourceChannel: LegacyOrderSourceChannel;
}): OrderChannelAttribution {
  if (!/^[a-z][a-z0-9._:-]{0,63}$/u.test(input.channelCode) || !Number.isSafeInteger(input.adapterVersion) || input.adapterVersion < 1) {
    throw new Error("order_channel_attribution_invalid");
  }
  return {
    adapterVersion: input.adapterVersion,
    channelCode: input.channelCode,
    legacySourceChannel: input.legacySourceChannel,
  };
}

export function prepareOrderChannelAttribution(input: {
  attribution?: OrderChannelAttribution;
  database: D1Database;
  orderId: string;
  shopId: string;
  channelCode?: BuiltInCommerceChannelCode;
  connectionId?: string | null;
  createdAt: string;
}): D1PreparedStatement {
  const attribution = input.attribution
    ?? (input.channelCode === undefined ? (() => { throw new Error("order_channel_attribution_missing"); })() : resolveOrderChannelAttribution(input.channelCode));
  return input.database.prepare(`
    INSERT INTO order_channel_attributions (
      shop_id, order_id, channel_code, adapter_version, connection_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    input.shopId,
    input.orderId,
    attribution.channelCode,
    attribution.adapterVersion,
    input.connectionId ?? null,
    input.createdAt,
  );
}
