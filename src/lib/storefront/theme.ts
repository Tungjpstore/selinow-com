import { createStorefrontTranslator } from "../i18n/catalogs/storefront";
import { parseHomeSections, type StorefrontSectionConfig } from "./sections/registry";

type JsonObject = Record<string, unknown>;

export type StorefrontTheme = {
  accent: string;
  accentInk: string;
  brand: string;
  brandInk: string;
  logoUrl: string | null;
};

export type StorefrontContent = {
  announcement: string | null;
  deliveryText: string;
  /** TM1: persisted home-section stack (empty/absent = template default tail). */
  sections?: StorefrontSectionConfig[];
  description: string;
  footerText: string;
  headline: string;
  seoDescription: string;
  seoTitle: string;
  showExactStock: boolean;
  supportText: string;
  templateId: string | null;
};

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function readText(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 && normalized.length <= maximum ? normalized : fallback;
}

function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 3)).trimEnd()}...`;
}

function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/u.test(normalized) ? normalized : fallback;
}

function relativeLuminance(hex: string): number {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => Number.parseInt(part, 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

export function contrastInk(background: string): string {
  const dark = "#0B1020";
  const light = "#FFFFFF";
  return contrast(background, dark) >= contrast(background, light) ? dark : light;
}

function safeLogoUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseStorefrontTheme(brandingJson: string): StorefrontTheme {
  const branding = parseJsonObject(brandingJson);
  const brand = normalizeHex(branding.primaryColor, "#5B5CEB");
  const accent = normalizeHex(branding.accentColor, "#7C3AED");
  return { accent, accentInk: contrastInk(accent), brand, brandInk: contrastInk(brand), logoUrl: safeLogoUrl(branding.logoUrl) };
}

export function parseStorefrontContent(storefrontJson: string, shopName: string, locale?: unknown): StorefrontContent {
  const storefront = parseJsonObject(storefrontJson);
  const t = createStorefrontTranslator(locale);
  const announcement = typeof storefront.announcement === "string" && storefront.announcement.trim().length > 0
    ? readText(storefront.announcement, "", 140)
    : null;
  const description = readText(storefront.description, t("storefront.defaults.description"), 240);
  const seoDescriptionFallback = truncateText(description, 160);
  const seoTitleFallback = truncateText(t("storefront.defaults.seo_title", { shop: shopName }), 60);
  // Raw persisted selection; the template registry resolves or safely falls
  // it back at render time, so parsing only needs to surface a plain string.
  const templateId = typeof storefront.templateId === "string" && storefront.templateId.trim().length > 0
    ? storefront.templateId.trim().slice(0, 32)
    : null;
  return {
    announcement,
    deliveryText: readText(storefront.deliveryText, t("storefront.defaults.delivery"), 240),
    description,
    sections: parseHomeSections(storefront.sections),
    footerText: readText(storefront.footerText, t("storefront.defaults.footer", { shop: shopName }), 160),
    headline: readText(storefront.headline, t("storefront.defaults.headline"), 120),
    seoDescription: readText(storefront.seoDescription, seoDescriptionFallback, 160),
    seoTitle: readText(storefront.seoTitle, seoTitleFallback, 60),
    showExactStock: storefront.showExactStock === true,
    supportText: readText(storefront.supportText, t("storefront.defaults.support"), 180),
    templateId,
  };
}

/** TM0: persisted home-section stack (empty = template default). */
export function parseStorefrontSections(storefrontJson: string): StorefrontSectionConfig[] {
  const storefront = parseJsonObject(storefrontJson);
  return parseHomeSections(storefront.sections);
}
