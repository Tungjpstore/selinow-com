import type { StorefrontVertical } from "../storefront/templates";
import { getStorefrontTemplate, listTemplatesForVertical } from "../storefront/templates";
import type { AppBindings } from "../platform/bindings";
import { listSellerCatalog } from "../catalog/store";
import { getPaymentIntegration } from "../payments/integrations";
import { getTelegramIntegration } from "../telegram/integrations";
import { getShopForMember } from "../tenants/store";

/**
 * Wizard resume projection (OB-B4). The onboarding page hydrates the 5-step
 * quickstart from server truth so a refresh (or a returning seller) re-enters
 * the wizard at the first step that still has work left, with the real
 * product / stock / integration state — instead of always restarting at step 1.
 */

/** Wizard step codes used by the client quickstart. */
export type OnboardingWizardStep = "connect" | "inventory" | "launch" | "product" | "store";

export type OnboardingResumeState = {
  catalog: {
    firstVariantId: string | null;
    firstVariantTitle: string | null;
    hasManualProduct: boolean;
    hasProducts: boolean;
    hasStock: boolean;
    totalAvailableStock: number;
  };
  channels: {
    telegramEnabled: boolean;
    websiteEnabled: boolean;
  };
  integrations: {
    payosReady: boolean;
    telegramBotUsername: string | null;
    telegramReady: boolean;
  };
  shop: {
    name: string;
    slug: string;
    templateId: string;
    vertical: StorefrontVertical;
  };
  /** Current shop_settings.version so template PATCHes use a real version. */
  storefrontVersion: number;
  /** First wizard step that still needs seller action. */
  wizardStep: OnboardingWizardStep;
};

type ShopResumeRow = {
  name: string;
  slug: string;
  storefrontJson: string;
  storefrontVersion: number;
  telegramChannelEnabled: number;
  vertical: StorefrontVertical | null;
  websiteChannelEnabled: number;
};

export async function getOnboardingResume(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<OnboardingResumeState | null> {
  const member = await getShopForMember({
    capability: "shop:update",
    env: input.env,
    shopPublicId: input.shopPublicId,
    subscriptionAction: "draft_setup",
    userId: input.userId,
  }).catch(() => null);
  if (member === null) return null;

  const [settingsRow, catalog, telegram, payos] = await Promise.all([
    input.env.PLATFORM_DB.prepare(`
      SELECT shops.name, shops.slug, shops.vertical, shop_settings.storefront_json AS storefrontJson,
        shop_settings.version AS storefrontVersion,
        profile.website_enabled AS websiteChannelEnabled,
        profile.telegram_enabled AS telegramChannelEnabled
      FROM shops
      INNER JOIN shop_settings ON shop_settings.shop_id = shops.id
      INNER JOIN shop_onboarding_profiles profile ON profile.shop_id = shops.id
      WHERE shops.id = ?
      LIMIT 1
    `).bind(member.row.shop_id).first<ShopResumeRow>(),
    listSellerCatalog({ env: input.env, shopPublicId: input.shopPublicId, userId: input.userId }).catch(() => null),
    getTelegramIntegration({ env: input.env, shopPublicId: input.shopPublicId, userId: input.userId }).catch(() => null),
    getPaymentIntegration({ env: input.env, shopPublicId: input.shopPublicId, userId: input.userId }).catch(() => null),
  ]);
  if (settingsRow === null) return null;

  const rawProducts: unknown = catalog?.products;
  const rawVariants: unknown = catalog?.variants;
  const products = (Array.isArray(rawProducts) ? rawProducts : []) as Array<{ fulfillmentType?: string; title?: string }>;
  const variants = (Array.isArray(rawVariants) ? rawVariants : []) as Array<{ availableStock?: number; id?: string; title?: string }>;

  const hasProducts = products.length > 0;
  const hasManualProduct = products.some((product) => product.fulfillmentType === "manual");
  const totalAvailableStock = variants.reduce((sum, variant) => sum + (typeof variant.availableStock === "number" ? variant.availableStock : 0), 0);
  const hasStock = totalAvailableStock > 0 || hasManualProduct;
  const firstVariant = variants[0] ?? null;

  const telegramConfigured = telegram !== null && telegram.status !== "disabled";
  const telegramReady = telegramConfigured && telegram.webhookStatus === "verified";
  const payosConfigured = payos !== null && payos.status !== "disabled";
  const payosReady = payosConfigured && payos.webhookStatus === "verified";

  let storefrontTemplateId: string | null = null;
  try {
    const parsed = JSON.parse(settingsRow.storefrontJson || "{}") as { templateId?: unknown };
    if (typeof parsed.templateId === "string") storefrontTemplateId = parsed.templateId;
  } catch {
    storefrontTemplateId = null;
  }
  const vertical = settingsRow.vertical ?? "digital";
  const scopedTemplates = listTemplatesForVertical(vertical);
  const templateId = storefrontTemplateId !== null && (getStorefrontTemplate(storefrontTemplateId)?.vertical === vertical)
    ? storefrontTemplateId
    : scopedTemplates[0]?.id ?? "swift";

  // Mirrors the onboarding overview's nextStep ordering: catalog → inventory →
  // payments → telegram → readiness. The wizard never resumes past a step
  // that still blocks publish. Telegram gating follows the CHANNEL flag (a
  // shop with the channel on but no bot yet must resume at Connect).
  const telegramChannelEnabled = settingsRow.telegramChannelEnabled === 1;
  let wizardStep: OnboardingWizardStep;
  if (!hasProducts) wizardStep = "product";
  else if (!hasStock) wizardStep = "inventory";
  else if (!payosReady) wizardStep = "connect";
  else if (telegramChannelEnabled && !telegramReady) wizardStep = "connect";
  else wizardStep = "launch";

  return {
    catalog: {
      firstVariantId: firstVariant?.id ?? null,
      firstVariantTitle: firstVariant?.title ?? products[0]?.title ?? null,
      hasManualProduct,
      hasProducts,
      hasStock,
      totalAvailableStock,
    },
    channels: {
      telegramEnabled: telegramChannelEnabled,
      websiteEnabled: settingsRow.websiteChannelEnabled === 1,
    },
    integrations: {
      payosReady,
      telegramBotUsername: telegram?.bot?.username ?? null,
      telegramReady,
    },
    shop: {
      name: settingsRow.name,
      slug: settingsRow.slug,
      templateId,
      vertical,
    },
    storefrontVersion: settingsRow.storefrontVersion,
    wizardStep,
  };
}
