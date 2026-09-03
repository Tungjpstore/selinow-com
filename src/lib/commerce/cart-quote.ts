import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import type { CommerceQuoteView } from "./contracts";
import { calculateCartDiscountMinor } from "./pricing";
import { createQuoteEvidence } from "./quote-evidence";
import { computeShippingFeeMinor, listStorefrontShippingMethods } from "./shipping";

export type CanonicalCartQuoteLine = {
  availableStock: number;
  currency: string;
  deliveryMode: "digital" | "shipping";
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
  shippingMethodId?: string;
}): Promise<CommerceQuoteView> {
  if (input.lines.length === 0) throw new AppError("cart_empty", 409);
  for (const line of input.lines) {
    if (line.status !== "active" || line.productStatus !== "active" || line.currency !== input.shop.currency) throw new AppError("catalog_changed", 409);
    if (line.quantity < line.minPerOrder || line.quantity > line.maxPerOrder) throw new AppError("quantity_unavailable", 409);
    // Stock is tracked for key inventory and physical variants; plain manual
    // digital products are unbounded and report zero available keys.
    const stockTracked = line.fulfillmentType === "license_key" || line.deliveryMode === "shipping";
    if (stockTracked && line.availableStock < line.quantity) throw new AppError("inventory_unavailable", 409);
  }
  const deliveryModes = new Set(input.lines.map((line) => line.deliveryMode));
  if (deliveryModes.size > 1) throw new AppError("mixed_fulfillment_unsupported", 409, ["split_cart_by_fulfillment"]);
  const isPhysical = deliveryModes.has("shipping");
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
  let shippingFeeMinor = 0;
  let shipping: CommerceQuoteView["shipping"];
  if (isPhysical) {
    const methods = await listStorefrontShippingMethods(input.env, input.shop.id);
    if (methods.length === 0) throw new AppError("shipping_method_unavailable", 409, ["shipping_not_configured"]);
    // The first quote renders before the buyer picks a method; default to the
    // shop's primary method so totals and evidence exist immediately.
    const selected = input.shippingMethodId === undefined
      ? methods[0]
      : methods.find((candidate) => candidate.id === input.shippingMethodId);
    if (selected === undefined) throw new AppError("shipping_method_not_found", 404);
    shippingFeeMinor = computeShippingFeeMinor(selected, subtotalMinor - discountMinor);
    shipping = {
      feeMinor: shippingFeeMinor,
      methodId: selected.id,
      methods: methods.map((candidate) => ({ feeMinor: candidate.feeMinor, freeOverMinor: candidate.freeOverMinor, id: candidate.id, name: candidate.name })),
    };
  } else if (input.shippingMethodId !== undefined) {
    throw new AppError("validation_failed", 400, ["shipping_method_not_applicable"]);
  }
  const totalMinor = subtotalMinor - discountMinor + shippingFeeMinor;
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
    pricing: {
      discountCode: input.discountCode,
      discountMinor,
      ...(shipping === undefined
        ? {}
        : shipping.methodId === null
          ? { shippingFeeMinor }
          : { shippingFeeMinor, shippingMethodId: shipping.methodId }),
      totalMinor,
    },
    secret: input.env.IDENTIFIER_HMAC_SECRET,
    shopId: input.shop.id,
  });
  return {
    currency: input.shop.currency,
    discountMinor,
    expiresAt,
    items,
    quoteEvidence,
    ...(shipping === undefined ? {} : { shipping }),
    subtotalMinor,
    totalMinor,
  };
}
