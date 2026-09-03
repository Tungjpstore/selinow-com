import { AppError } from "../core/errors";
import { normalizeCurrencyCode } from "../i18n/currency";

function normalizeText(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, [`${field}_required`]);
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new AppError("validation_failed", 400, [`${field}_invalid`]);
  }
  return normalized;
}

export function normalizeCatalogName(value: unknown, field = "name"): string {
  return normalizeText(value, field, 2, 120);
}

export function normalizeDescription(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 10_000) {
    throw new AppError("validation_failed", 400, ["description_invalid"]);
  }
  return value.trim();
}

export function normalizeCatalogSlug(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["slug_required"]);
  }
  const slug = value.trim().toLowerCase();
  if (slug.length < 2 || slug.length > 80 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u.test(slug) || slug.includes("--")) {
    throw new AppError("validation_failed", 400, ["slug_invalid"]);
  }
  return slug;
}

export function normalizeSku(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["sku_required"]);
  }
  const sku = value.trim().toUpperCase();
  if (sku.length < 1 || sku.length > 64 || !/^[A-Z0-9][A-Z0-9._-]*$/u.test(sku)) {
    throw new AppError("validation_failed", 400, ["sku_invalid"]);
  }
  return sku;
}

export function requireInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AppError("validation_failed", 400, [`${field}_invalid`]);
  }
  return value;
}

export function normalizeCurrency(value: unknown, fallback: string): string {
  const currency = value === undefined ? fallback : value;
  const normalized = normalizeCurrencyCode(currency);
  if (normalized === null) {
    throw new AppError("validation_failed", 400, ["currency_invalid"]);
  }
  return normalized;
}

export function normalizeOptions(value: unknown): string {
  if (value === undefined) return "{}";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation_failed", 400, ["options_invalid"]);
  }
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 4_096) {
    throw new AppError("validation_failed", 400, ["options_invalid"]);
  }
  return json;
}

/**
 * Seller-authored spec rows rendered on storefront detail pages (SpecTable,
 * warranty badges). Accepts [{label, value}]; returns the JSON payload for
 * products.attributes_json or null when the product carries none. Mirrors the
 * storefront-side parse bounds so writes and renders agree.
 */
export function normalizeProductAttributes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new AppError("validation_failed", 400, ["attributes_invalid"]);
  const rows: Array<{ label: string; value: string }> = [];
  for (const entry of value.slice(0, 20)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AppError("validation_failed", 400, ["attributes_invalid"]);
    }
    const label = (entry as Record<string, unknown>).label;
    const attributeValue = (entry as Record<string, unknown>).value;
    if (typeof label !== "string" || typeof attributeValue !== "string") {
      throw new AppError("validation_failed", 400, ["attributes_invalid"]);
    }
    const trimmedLabel = label.trim().slice(0, 40);
    const trimmedValue = attributeValue.trim().slice(0, 120);
    if (trimmedLabel === "" || trimmedValue === "") continue;
    rows.push({ label: trimmedLabel, value: trimmedValue });
  }
  if (rows.length === 0) return null;
  return JSON.stringify(rows);
}

export function requireResourceId(value: string | undefined, prefix: string): string {
  if (value === undefined || !new RegExp(`^${prefix}_[0-9a-f-]{36}$`, "u").test(value)) {
    throw new AppError("resource_not_found", 404);
  }
  return value;
}

export function parseInventoryKeys(value: unknown, source: "csv" | "paste"): string[] {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["inventory_payload_required"]);
  }
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const keys = lines.map((line) => source === "csv" ? (line.split(",", 1)[0] ?? "").trim() : line.trim()).filter(Boolean);
  if (keys.length === 0 || keys.length > 1_000) {
    throw new AppError("validation_failed", 400, ["inventory_count_invalid"]);
  }
  if (keys.some((key) => key.length > 1_024 || new TextEncoder().encode(key).byteLength > 2_048)) {
    throw new AppError("validation_failed", 400, ["inventory_key_invalid"]);
  }
  if (new Set(keys).size !== keys.length) {
    throw new AppError("inventory_duplicate", 409);
  }
  return keys;
}
