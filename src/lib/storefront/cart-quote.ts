export type ClientCartVariant = {
  priceMinor: number;
  productTitle: string;
  variantTitle: string;
  version: number;
};

export type ServerQuoteItem = {
  productTitle: string;
  quantity: number;
  unitPriceMinor: number;
  variantId: string;
  variantTitle: string;
  variantVersion: number;
};

export type CartQuoteChange = "item_changed" | "price_changed" | "ready";

export function classifyCartQuote(
  local: ReadonlyMap<string, ClientCartVariant>,
  items: readonly ServerQuoteItem[],
): CartQuoteChange {
  let itemChanged = false;
  for (const item of items) {
    const variant = local.get(item.variantId);
    if (variant === undefined) return "item_changed";
    if (variant.priceMinor !== item.unitPriceMinor) return "price_changed";
    if (
      variant.version !== item.variantVersion
      || variant.productTitle !== item.productTitle
      || variant.variantTitle !== item.variantTitle
    ) itemChanged = true;
  }
  return itemChanged ? "item_changed" : "ready";
}
