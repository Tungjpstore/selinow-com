import { AppError } from "../core/errors";
import { parseHomeSections } from "../storefront/sections/registry";
import type { AppBindings } from "../platform/bindings";
import { hasFeature } from "../tenants/policy";
import {
  listStorefrontTemplates,
  PREMIUM_STOREFRONT_TEMPLATES_FEATURE,
  resolveStorefrontTemplate,
  storefrontTemplateSelectionIssue,
  type StorefrontTemplateDefinition,
} from "../storefront/templates";
import { parseStorefrontContent, parseStorefrontTheme, type StorefrontContent, type StorefrontTheme } from "../storefront/theme";
import { publishReadyStorefront } from "./readiness";
import { getShopForMember } from "./store";

export type StorefrontPublicationState = "never_published" | "published" | "unpublished_changes";

export type SellerStorefrontSettings = {
  content: StorefrontContent;
  hasUnpublishedChanges: boolean;
  premiumTemplatesEnabled: boolean;
  publicationState: StorefrontPublicationState;
  publishedAt: string | null;
  publishedVersion: number;
  shopName: string;
  template: StorefrontTemplateDefinition;
  templates: readonly StorefrontTemplateDefinition[];
  theme: StorefrontTheme;
  version: number;
};

type SettingsRow = {
  brandingJson: string;
  publishedAt: string | null;
  publishedVersion: number;
  storefrontJson: string;
  version: number;
};

function objectJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maximum) throw new AppError("validation_failed", 400, ["storefront_text_invalid"]);
  return normalized;
}

function optionalText(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === "string" && value.trim().length === 0)) return null;
  return text(value, maximum) ?? null;
}

function hex(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value.trim())) throw new AppError("validation_failed", 400, ["storefront_color_invalid"]);
  return value.trim().toUpperCase();
}

function httpsUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500) throw new AppError("validation_failed", 400, ["storefront_logo_invalid"]);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("protocol");
    return url.toString();
  } catch {
    throw new AppError("validation_failed", 400, ["storefront_logo_invalid"]);
  }
}

function expectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError("validation_failed", 400, ["storefront_version_invalid"]);
  }
  return value;
}

function publicationState(row: SettingsRow): StorefrontPublicationState {
  if (row.publishedVersion < 1 || row.publishedAt === null) return "never_published";
  return row.publishedVersion === row.version ? "published" : "unpublished_changes";
}

async function readSettings(env: AppBindings, shopId: string, shopName: string, locale: unknown, premiumTemplatesEnabled: boolean): Promise<SellerStorefrontSettings> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT branding_json AS brandingJson, storefront_json AS storefrontJson, version,
      published_version AS publishedVersion, published_at AS publishedAt
    FROM shop_settings
    WHERE shop_id = ?
    LIMIT 1
  `).bind(shopId).first<SettingsRow>();
  if (row === null) throw new AppError("resource_not_found", 404);
  const state = publicationState(row);
  const content = parseStorefrontContent(row.storefrontJson, shopName, locale);
  return {
    content,
    hasUnpublishedChanges: state !== "published",
    premiumTemplatesEnabled,
    publicationState: state,
    publishedAt: row.publishedAt,
    publishedVersion: row.publishedVersion,
    shopName,
    template: resolveStorefrontTemplate({ premiumEntitled: premiumTemplatesEnabled, templateId: content.templateId }),
    templates: listStorefrontTemplates(),
    theme: parseStorefrontTheme(row.brandingJson),
    version: row.version,
  };
}

export async function getSellerStorefrontSettings(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<SellerStorefrontSettings> {
  const member = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  return readSettings(
    input.env,
    member.row.shop_id,
    member.shop.name,
    member.shop.defaultLocale,
    hasFeature(member.row.feature_flags_json, PREMIUM_STOREFRONT_TEMPLATES_FEATURE),
  );
}

export const LOW_STOCK_THRESHOLD_MAX = 1000;

export async function updateShopLowStockThreshold(input: {
  env: AppBindings;
  expectedVersion?: number;
  shopPublicId: string;
  threshold: number;
  userId: string;
}): Promise<{ lowStockThreshold: number; version: number }> {
  const member = await getShopForMember({ capability: "shop:update", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  // Matches the shop_settings CHECK constraint (low_stock_threshold >= 0);
  // the column already exists in migration 0002, so no schema change is needed.
  if (!Number.isSafeInteger(input.threshold) || input.threshold < 0 || input.threshold > LOW_STOCK_THRESHOLD_MAX) {
    throw new AppError("validation_failed", 400, ["low_stock_threshold_invalid"]);
  }
  const now = new Date().toISOString();
  if (input.expectedVersion === undefined) {
    const updated = await input.env.PLATFORM_DB.prepare(`UPDATE shop_settings SET low_stock_threshold = ?, version = version + 1, updated_at = ? WHERE shop_id = ? RETURNING low_stock_threshold AS lowStockThreshold, version`).bind(input.threshold, now, member.row.shop_id).first<{ lowStockThreshold: number; version: number }>();
    if (updated === null) throw new AppError("resource_not_found", 404);
    return updated;
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new AppError("validation_failed", 400, ["storefront_version_invalid"]);
  }
  const updated = await input.env.PLATFORM_DB.prepare(`UPDATE shop_settings SET low_stock_threshold = ?, version = version + 1, updated_at = ? WHERE shop_id = ? AND version = ? RETURNING low_stock_threshold AS lowStockThreshold, version`).bind(input.threshold, now, member.row.shop_id, input.expectedVersion).first<{ lowStockThreshold: number; version: number }>();
  if (updated === null) throw new AppError("resource_conflict", 409, ["settings_version_stale"]);
  return updated;
}

export async function updateSellerStorefrontSettings(input: {
  data: Record<string, unknown>;
  env: AppBindings;
  expectedVersion: unknown;
  shopPublicId: string;
  userId: string;
}): Promise<SellerStorefrontSettings> {
  const member = await getShopForMember({ capability: "shop:update", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const premiumTemplatesEnabled = hasFeature(member.row.feature_flags_json, PREMIUM_STOREFRONT_TEMPLATES_FEATURE);
  const version = expectedVersion(input.expectedVersion);
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT branding_json AS brandingJson, storefront_json AS storefrontJson, version,
      published_version AS publishedVersion, published_at AS publishedAt
    FROM shop_settings
    WHERE shop_id = ?
    LIMIT 1
  `).bind(member.row.shop_id).first<SettingsRow>();
  if (existing === null) throw new AppError("resource_not_found", 404);
  if (existing.version !== version) throw new AppError("resource_conflict", 409, ["storefront_draft_stale"]);
  const branding = objectJson(existing.brandingJson);
  const storefront = objectJson(existing.storefrontJson);
  const primaryColor = hex(input.data.primaryColor);
  const accentColor = hex(input.data.accentColor);
  const logoUrl = httpsUrl(input.data.logoUrl);
  const fields: Array<[keyof typeof storefront, number]> = [["headline", 120], ["description", 240], ["deliveryText", 240], ["supportText", 180], ["footerText", 160]];
  for (const [field, maximum] of fields) {
    const value = text(input.data[field], maximum);
    if (value !== undefined) storefront[field] = value;
  }
  const seoTitle = optionalText(input.data.seoTitle, 60);
  const seoDescription = optionalText(input.data.seoDescription, 160);
  if (seoTitle !== undefined) {
    if (seoTitle === null) delete storefront.seoTitle;
    else storefront.seoTitle = seoTitle;
  }
  if (seoDescription !== undefined) {
    if (seoDescription === null) delete storefront.seoDescription;
    else storefront.seoDescription = seoDescription;
  }
  if (input.data.announcement !== undefined) {
    if (input.data.announcement === null || input.data.announcement === "") delete storefront.announcement;
    else storefront.announcement = text(input.data.announcement, 140);
  }
  if (input.data.showExactStock !== undefined) {
    if (typeof input.data.showExactStock !== "boolean") throw new AppError("validation_failed", 400, ["show_exact_stock_invalid"]);
    storefront.showExactStock = input.data.showExactStock;
  }
  if (input.data.sections !== undefined) {
    // TM1: bounded parse is the validator; the persisted draft only ever
    // contains the cleaned array.
    const parsed = parseHomeSections(input.data.sections);
    if (parsed.length === 0) delete storefront.sections;
    else storefront.sections = parsed;
  }
  if (input.data.templateId !== undefined) {
    const selection = storefrontTemplateSelectionIssue({ premiumEntitled: premiumTemplatesEnabled, templateId: input.data.templateId });
    if (selection === "storefront_template_invalid") throw new AppError("validation_failed", 400, [selection]);
    if (selection === "storefront_template_premium_required") throw new AppError("authorization_denied", 403, [selection]);
    storefront.templateId = selection.id;
  }
  if (primaryColor !== undefined) branding.primaryColor = primaryColor;
  if (accentColor !== undefined) branding.accentColor = accentColor;
  if (logoUrl !== undefined) branding.logoUrl = logoUrl;
  const now = new Date().toISOString();
  const updated = await input.env.PLATFORM_DB.prepare(`UPDATE shop_settings SET branding_json = ?, storefront_json = ?, version = version + 1, updated_at = ? WHERE shop_id = ? AND version = ? RETURNING version`).bind(JSON.stringify(branding), JSON.stringify(storefront), now, member.row.shop_id, version).first<{ version: number }>();
  if (updated === null) throw new AppError("resource_conflict", 409);
  return readSettings(input.env, member.row.shop_id, member.shop.name, member.shop.defaultLocale, premiumTemplatesEnabled);
}

export async function publishSellerStorefrontSettings(input: {
  env: AppBindings;
  expectedVersion?: unknown;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<SellerStorefrontSettings> {
  const member = await getShopForMember({ capability: "shop:update", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  if (member.row.role !== "owner") throw new AppError("authorization_denied", 403);
  const current = await input.env.PLATFORM_DB.prepare("SELECT version FROM shop_settings WHERE shop_id = ? LIMIT 1")
    .bind(member.row.shop_id).first<{ version: number }>();
  if (current === null) throw new AppError("resource_not_found", 404);
  const version = input.expectedVersion === undefined ? current.version : expectedVersion(input.expectedVersion);
  if (current.version !== version) throw new AppError("resource_conflict", 409, ["storefront_draft_stale"]);

  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_settings
    SET published_branding_json = branding_json,
        published_storefront_json = storefront_json,
        published_version = version,
        published_at = ?
    WHERE shop_id = ? AND version = ?
  `).bind(now, member.row.shop_id, version).run();

  try {
    await publishReadyStorefront({
      env: input.env,
      expectedStorefrontVersion: version,
      requestId: input.requestId,
      shopPublicId: input.shopPublicId,
      userId: input.userId,
    });
  } catch {
    // Non-fatal if shop still has onboarding prerequisites pending (e.g. PayOS/Telegram connection)
  }

  return readSettings(
    input.env,
    member.row.shop_id,
    member.shop.name,
    member.shop.defaultLocale,
    hasFeature(member.row.feature_flags_json, PREMIUM_STOREFRONT_TEMPLATES_FEATURE),
  );
}
