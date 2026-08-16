import { formatMoney, normalizeCurrencyCode } from "../../lib/i18n/currency";
import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";

export type CatalogEntry = {
  currency: string;
  deliveryMode: "digital" | "shipping";
  durationMinutes: number | null;
  maxQuantity: number;
  minQuantity: number;
  priceMinor: number;
  productTitle: string;
  stockState: string;
  variantId: string;
  variantTitle: string;
  version: number;
};

export type CartEntry = { quantity: number; variantId: string };

export function readCatalog(): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  const t = createStorefrontTranslator(document.documentElement.lang || "en");
  const template = document.querySelector("#catalog-data");
  if (!(template instanceof HTMLTemplateElement)) return catalog;
  for (const node of template.content.querySelectorAll("[data-catalog-variant]")) {
    if (!(node instanceof HTMLElement) || node.dataset.variantId === undefined) continue;
    const currency = normalizeCurrencyCode(node.dataset.currency);
    if (currency === null) continue;
    catalog.set(node.dataset.variantId, {
      currency,
      deliveryMode: node.dataset.deliveryMode === "shipping" ? "shipping" : "digital",
      durationMinutes: node.dataset.durationMinutes === undefined ? null : Number.parseInt(node.dataset.durationMinutes, 10),
      maxQuantity: Number.parseInt(node.dataset.maxQuantity ?? "1", 10),
      minQuantity: Number.parseInt(node.dataset.minQuantity ?? "1", 10),
      priceMinor: Number.parseInt(node.dataset.priceMinor ?? "0", 10),
      productTitle: node.dataset.productTitle ?? t("storefront.catalog.product_fallback"),
      stockState: node.dataset.stockState ?? "available",
      variantId: node.dataset.variantId,
      variantTitle: node.dataset.variantTitle ?? t("storefront.catalog.variant_fallback"),
      version: Number.parseInt(node.dataset.version ?? "1", 10),
    });
  }
  return catalog;
}

export function cartStorageKey(): string {
  return `selinow-cart:v1:${window.location.host}`;
}

export function readCart(catalog?: Map<string, CatalogEntry>): CartEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(cartStorageKey()) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): CartEntry[] => {
      if (typeof value !== "object" || value === null) return [];
      const row = value as Record<string, unknown>;
      if (typeof row.variantId !== "string" || typeof row.quantity !== "number" || !Number.isInteger(row.quantity) || row.quantity < 1) return [];
      if (catalog !== undefined && !catalog.has(row.variantId)) return [];
      return [{ quantity: row.quantity, variantId: row.variantId }];
    });
  } catch {
    return [];
  }
}

export function saveCart(cart: CartEntry[]): void {
  localStorage.setItem(cartStorageKey(), JSON.stringify(cart));
  window.dispatchEvent(new Event("selinow:cart-updated"));
}

export function formatClientMoney(minor: number, currency: string): string {
  return formatMoney(minor, currency, document.documentElement.lang || "en");
}
