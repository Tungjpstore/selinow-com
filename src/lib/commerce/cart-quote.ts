import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import type { CommerceQuoteView } from "./contracts";
import { calculateCartDiscountMinor } from "./pricing";
import { createQuoteEvidence } from "./quote-evidence";

export type CanonicalCartQuoteLine = {
  availableStock: number;
  currency: string;
  fulfillmentType: "license_key" | "manual";
  maxPerOrder: number;
  minPerOrder: number;
  priceMinor: number;
  productStatus: string;
  productTitle: string;
  productVersion: number;
  quantity: number;
  status: string;
  title: string;
  variantId: string;
  version: number;
};

export async function projectCanonicalCartQuote(input: {
  cartExpiresAt: string;
  cartId: string;
  discountCode: string | null;
  env: AppBindings;
  lines: readonly CanonicalCartQuoteLine[];
  shop: { currency: string; id: string };
}): Promise<CommerceQuoteView> {
  if (input.lines.length === 0) throw new AppError("cart_empty", 409);
  for (const line of input.lines) {
    if (line.status !== "active" || line.productStatus !== "active" || line.currency !== input.shop.currency) throw new AppError("catalog_changed", 409);
    if (line.quantity < line.minPerOrder || line.quantity > line.maxPerOrder) throw new AppError("quantity_unavailable", 409);
    if (line.fulfillmentType === "license_key" && line.availableStock < line.quantity) throw new AppError("inventory_unavailable", 409);
  }
  const items = input.lines.map((line) => ({
    lineTotalMinor: line.priceMinor * line.quantity,
    productTitle: line.productTitle,
    quantity: line.quantity,
    unitPriceMinor: line.priceMinor,
    variantId: line.variantId,
    variantTitle: line.title,
    variantVersion: line.version,
  }));
  const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  const discountMinor = await calculateCartDiscountMinor({ code: input.discountCode, env: input.env, shop: input.shop, subtotalMinor });
  const totalMinor = subtotalMinor - discountMinor;
  const issuedAt = new Date();
  const expiresAt = new Date(Math.min(issuedAt.getTime() + 5 * 60_000, Date.parse(input.cartExpiresAt))).toISOString();
  const quoteEvidence = await createQuoteEvidence({
    catalog: input.lines.map((line) => ({
      productVersion: line.productVersion,
      quantity: line.quantity,
      unitPriceMinor: line.priceMinor,
      variantId: line.variantId,
      variantVersion: line.version,
    })),
    cartExpiresAt: input.cartExpiresAt,
    cartId: input.cartId,
    expected: items,
    expiresAt,
    issuedAt: issuedAt.toISOString(),
    pricing: { discountCode: input.discountCode, discountMinor, totalMinor },
    secret: input.env.IDENTIFIER_HMAC_SECRET,
    shopId: input.shop.id,
  });
  return { currency: input.shop.currency, discountMinor, expiresAt, items, quoteEvidence, subtotalMinor, totalMinor };
}
