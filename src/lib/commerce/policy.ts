import { AppError } from "../core/errors";
import { matchSupportedLocale, type SupportedLocale } from "../i18n/locale";

export type CartItemInput = { quantity: number; variantId: string };

/** Mixed automatic/manual carts have no provider-neutral fulfillment state. */
export function assertSupportedFulfillmentComposition(lines: readonly { deliveryMode?: "digital" | "shipping"; fulfillmentType: "license_key" | "manual" }[]): void {
  const modes = new Set(lines.map((line) => line.fulfillmentType));
  if (modes.size > 1) throw new AppError("mixed_fulfillment_unsupported", 409, ["split_cart_by_fulfillment"]);
  // Physical (shipping) and digital lines ship and settle differently; one
  // cart stays in one delivery mode.
  const deliveryModes = new Set(lines.map((line) => line.deliveryMode ?? "digital"));
  if (deliveryModes.size > 1) throw new AppError("mixed_fulfillment_unsupported", 409, ["split_cart_by_fulfillment"]);
}

export function parseCartItems(value: unknown): CartItemInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new AppError("validation_failed", 400, ["cart_items_invalid"]);
  }
  const items = value.map((item): CartItemInput => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new AppError("validation_failed", 400, ["cart_item_invalid"]);
    const candidate = item as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => !new Set(["quantity", "variantId"]).has(key))) throw new AppError("validation_failed", 400, ["cart_item_invalid"]);
    if (typeof candidate.variantId !== "string" || !/^var_[0-9a-f-]{36}$/u.test(candidate.variantId)) throw new AppError("validation_failed", 400, ["variant_id_invalid"]);
    if (typeof candidate.quantity !== "number" || !Number.isSafeInteger(candidate.quantity) || candidate.quantity < 1 || candidate.quantity > 1_000) throw new AppError("validation_failed", 400, ["quantity_invalid"]);
    return { quantity: candidate.quantity, variantId: candidate.variantId };
  });
  if (new Set(items.map((item) => item.variantId)).size !== items.length) throw new AppError("validation_failed", 400, ["cart_variant_duplicate"]);
  return items;
}

export function normalizeLocale(value: unknown, fallback: string): SupportedLocale {
  const locale = value === undefined ? fallback : value;
  const normalized = matchSupportedLocale(locale);
  if (normalized === null) throw new AppError("validation_failed", 400, ["locale_invalid"]);
  return normalized;
}

export function normalizeCustomerEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new AppError("validation_failed", 400, ["email_invalid"]);
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new AppError("validation_failed", 400, ["email_invalid"]);
  return email;
}

export function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const [local = "", domain = ""] = email.split("@", 2);
  return `${local.slice(0, 1)}***@${domain}`;
}
