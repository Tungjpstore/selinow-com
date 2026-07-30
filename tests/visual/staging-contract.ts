import type { ServerQuoteItem } from "../../src/lib/storefront/cart-quote";

export const signalVisualProduct = {
  addToCartName: "Thêm vào giỏ: Signal Editor Lifetime",
  heading: "Signal Editor Lifetime",
  path: "/products/signal-editor-lifetime",
  quoteItem: {
    productTitle: "Signal Editor Lifetime",
    quantity: 1,
    unitPriceMinor: 249_000,
    variantId: "var_61000000-0000-4000-8000-000000000001",
    variantTitle: "Lifetime",
    variantVersion: 1,
  } satisfies ServerQuoteItem,
} as const;

export const publicVisualScreenshots = [
  "storefront-home.png",
  "product-detail.png",
  "cart.png",
  "checkout.png",
  "login.png",
] as const;
