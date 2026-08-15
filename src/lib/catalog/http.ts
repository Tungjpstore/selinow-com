import { AppError } from "../core/errors";
import { rejectUnknownFields } from "../http/request";
import {
  normalizeCatalogName,
  normalizeCatalogSlug,
  normalizeCurrency,
  normalizeDescription,
  normalizeOptions,
  normalizeSku,
  requireInteger,
} from "./policy";
import type { CategoryInput, ProductInput, VariantInput } from "./store";

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AppError("validation_failed", 400, [`${field}_invalid`]);
  }
  return value as T;
}

export function parseCategoryInput(body: Record<string, unknown>): CategoryInput {
  rejectUnknownFields(body, ["description", "name", "slug", "sortOrder", "status"]);
  return {
    description: normalizeDescription(body.description),
    name: normalizeCatalogName(body.name),
    slug: normalizeCatalogSlug(body.slug),
    sortOrder: body.sortOrder === undefined ? 0 : requireInteger(body.sortOrder, "sort_order", -10_000, 10_000),
    status: body.status === undefined ? "draft" : oneOf(body.status, ["active", "archived", "draft"], "status"),
  };
}

export function parseProductInput(body: Record<string, unknown>): ProductInput {
  rejectUnknownFields(body, ["categoryId", "deliveryMode", "description", "fulfillmentType", "slug", "status", "title"]);
  const categoryId = body.categoryId === null || body.categoryId === undefined ? null : body.categoryId;
  if (categoryId !== null && (typeof categoryId !== "string" || !/^cat_[0-9a-f-]{36}$/u.test(categoryId))) {
    throw new AppError("validation_failed", 400, ["category_id_invalid"]);
  }
  const fulfillmentType = body.fulfillmentType === undefined ? "license_key" : oneOf(body.fulfillmentType, ["license_key", "manual"], "fulfillment_type");
  const deliveryMode = body.deliveryMode === undefined ? "digital" : oneOf(body.deliveryMode, ["digital", "shipping"], "delivery_mode");
  // Physical goods ship by hand: they are always seller-fulfilled products.
  if (deliveryMode === "shipping" && fulfillmentType !== "manual") {
    throw new AppError("validation_failed", 400, ["delivery_mode_fulfillment_mismatch"]);
  }
  return {
    categoryId,
    deliveryMode,
    description: normalizeDescription(body.description),
    fulfillmentType,
    slug: normalizeCatalogSlug(body.slug),
    status: body.status === undefined ? "draft" : oneOf(body.status, ["active", "archived", "draft", "suspended"], "status"),
    title: normalizeCatalogName(body.title, "title"),
  };
}

export function parseProductWithInitialVariantInput(
  body: Record<string, unknown>,
  defaultCurrency?: string,
): { product: ProductInput; variant: VariantInput } {
  rejectUnknownFields(body, ["categoryId", "deliveryMode", "description", "fulfillmentType", "initialVariant", "slug", "status", "title"]);
  const initialVariant = body.initialVariant;
  if (typeof initialVariant !== "object" || initialVariant === null || Array.isArray(initialVariant)) {
    throw new AppError("validation_failed", 400, ["initial_variant_required"]);
  }
  return {
    product: parseProductInput({
      categoryId: body.categoryId,
      deliveryMode: body.deliveryMode,
      description: body.description,
      fulfillmentType: body.fulfillmentType,
      slug: body.slug,
      status: body.status,
      title: body.title,
    }),
    variant: parseVariantInput(initialVariant as Record<string, unknown>, defaultCurrency),
  };
}

export function parseVariantInput(body: Record<string, unknown>, defaultCurrency?: string): VariantInput {
  rejectUnknownFields(body, ["compareAtMinor", "currency", "maxPerOrder", "minPerOrder", "options", "priceMinor", "sku", "status", "title"]);
  const priceMinor = requireInteger(body.priceMinor, "price_minor", 0, 9_000_000_000_000);
  const compareAtMinor = body.compareAtMinor === null || body.compareAtMinor === undefined
    ? null
    : requireInteger(body.compareAtMinor, "compare_at_minor", priceMinor, 9_000_000_000_000);
  const minPerOrder = body.minPerOrder === undefined ? 1 : requireInteger(body.minPerOrder, "min_per_order", 1, 1_000);
  const maxPerOrder = body.maxPerOrder === undefined ? 10 : requireInteger(body.maxPerOrder, "max_per_order", minPerOrder, 1_000);
  const currency = body.currency === undefined && defaultCurrency === undefined
    ? undefined
    : normalizeCurrency(body.currency, defaultCurrency ?? "");
  return {
    compareAtMinor,
    currency,
    maxPerOrder,
    minPerOrder,
    optionsJson: normalizeOptions(body.options),
    priceMinor,
    sku: normalizeSku(body.sku),
    status: body.status === undefined ? "active" : oneOf(body.status, ["active", "archived", "suspended"], "status"),
    title: normalizeCatalogName(body.title, "title"),
  };
}
