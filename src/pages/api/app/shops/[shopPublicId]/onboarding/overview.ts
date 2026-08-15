import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { listSellerCatalog } from "../../../../../../lib/catalog/store";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getPaymentIntegration } from "../../../../../../lib/payments/integrations";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { getTelegramIntegration } from "../../../../../../lib/telegram/integrations";
import { getShopReadiness } from "../../../../../../lib/tenants/readiness";
import { getShopForMember } from "../../../../../../lib/tenants/store";
import { getOnboardingState } from "../../../../../../lib/onboarding/store";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");

    const actor = await getShopForMember({
      capability: "shop:read",
      env,
      shopPublicId,
      subscriptionAction: "read",
      userId: auth.userId,
    });

    const [onboardingState, catalog, telegram, payos, readiness] = await Promise.all([
      getOnboardingState({ env, shopPublicId, userId: auth.userId }).catch(() => null),
      listSellerCatalog({ env, shopPublicId, userId: auth.userId }).catch(() => ({ products: [], variants: [] })),
      getTelegramIntegration({ env, shopPublicId, userId: auth.userId }).catch(() => null),
      getPaymentIntegration({ env, shopPublicId, userId: auth.userId }).catch(() => null),
      getShopReadiness({ env, shopPublicId, userId: auth.userId }).catch(() => null),
    ]);

    const rawProducts = (Array.isArray(catalog.products) ? catalog.products : []) as Array<Record<string, unknown>>;
    const rawVariants = (Array.isArray(catalog.variants) ? catalog.variants : []) as Array<Record<string, unknown>>;

    const productCount = rawProducts.length;
    const variantCount = rawVariants.length;
    const totalAvailableStock = rawVariants.reduce((sum, v) => sum + (typeof v.availableStock === "number" ? v.availableStock : 0), 0);

    const hasProducts = productCount > 0;
    const hasManualProduct = rawProducts.some((p) => p.fulfillmentType === "manual");
    const hasStock = totalAvailableStock > 0 || hasManualProduct;

    const telegramConfigured = telegram !== null && telegram.status !== "disabled";
    const telegramReady = telegramConfigured && telegram.webhookStatus === "verified";

    const payosConfigured = payos !== null && payos.status !== "disabled";
    const payosReady = payosConfigured && payos.webhookStatus === "verified";

    const websiteEnabled = onboardingState?.profile.websiteEnabled ?? false;
    const telegramEnabled = onboardingState?.profile.telegramEnabled ?? false;

    // Build checklist items
    const checklistItems = [
      {
        actionUrl: `/onboarding#store`,
        completed: true,
        description: "Khởi tạo thông tin và định danh cửa hàng",
        id: "create_store",
        required: true,
        title: "Tạo cửa hàng",
      },
      {
        actionUrl: `/onboarding#products`,
        completed: hasProducts,
        description: "Thêm ít nhất 1 sản phẩm kỹ thuật số",
        id: "add_product",
        required: true,
        title: "Thêm sản phẩm đầu tiên",
      },
      {
        actionUrl: `/onboarding#inventory`,
        completed: hasStock,
        description: "Nhập danh sách mã thẻ / key kích hoạt hoặc cấu hình giao thủ công",
        id: "import_inventory",
        required: true,
        title: "Nhập kho sản phẩm",
      },
      {
        actionUrl: `/onboarding#payos`,
        completed: payosReady,
        description: "Kết nối tài khoản ngân hàng nhận tiền tự động qua VietQR PayOS",
        id: "connect_payos",
        required: true,
        title: "Kết nối thanh toán PayOS",
      },
      ...(telegramEnabled ? [{
        actionUrl: `/onboarding#telegram`,
        completed: telegramReady,
        description: "Kết nối Bot Telegram để khách mua trực tiếp 24/7",
        id: "connect_telegram",
        required: true,
        title: "Kết nối Bot Telegram",
      }] : []),
    ];

    const completedCount = checklistItems.filter((item) => item.completed).length;
    const totalCount = checklistItems.length;
    const percent = totalCount === 0 ? 100 : Math.round((completedCount / totalCount) * 100);

    let nextStep = "ready";
    if (!hasProducts) nextStep = "products";
    else if (!hasStock) nextStep = "inventory";
    else if (!payosReady) nextStep = "payos";
    else if (telegramEnabled && !telegramReady) nextStep = "telegram";
    else if (readiness?.ready !== true) nextStep = "readiness";

    return Response.json({
      catalog: {
        hasManualProduct,
        hasProducts,
        hasStock,
        productCount,
        totalAvailableStock,
        variantCount,
      },
      channels: {
        customDomainPreference: onboardingState?.profile.customDomainPreference ?? "later",
        telegramEnabled,
        websiteEnabled,
      },
      checklist: {
        completedSteps: completedCount,
        items: checklistItems,
        percent,
        totalSteps: totalCount,
      },
      integrations: {
        payos: {
          configured: payosConfigured,
          ready: payosReady,
          status: payos?.status ?? null,
        },
        telegram: {
          botUsername: telegram?.bot?.username ?? null,
          configured: telegramConfigured,
          enabled: telegramEnabled,
          ready: telegramReady,
          status: telegram?.status ?? null,
        },
      },
      nextStep,
      ok: true,
      readiness: {
        checkedAt: readiness?.checkedAt ?? null,
        checks: readiness?.checks ?? [],
        ready: readiness?.ready ?? false,
      },
      requestId: locals.requestId,
      shop: {
        currency: actor.shop.currency,
        defaultLocale: actor.shop.defaultLocale,
        name: actor.shop.name,
        publicId: actor.shop.publicId,
        slug: actor.shop.slug,
        status: actor.shop.status,
        subscriptionState: actor.shop.subscriptionState,
      },
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
