import type { APIRoute } from "astro";

import { WEBSITE_CHANNEL_CODE } from "../../../../../../../../lib/channels/builtins";
import { createWebsiteCommerceApplication } from "../../../../../../../../lib/commerce/website-port";
import { AppError } from "../../../../../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../../lib/platform/bindings";
import { normalizeSupportedLocale } from "../../../../../../../../lib/i18n/locale";
import { requireResourceId } from "../../../../../../../../lib/catalog/policy";
import { resolveStorefrontShop } from "../../../../../../../../lib/storefront/store";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    const orderPublicId = params.orderPublicId;
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
    const orderToken = request.headers.get("X-Order-Access-Token");
    const grantToken = request.headers.get("X-Delivery-Grant-Token");
    if (orderPublicId === undefined || !/^order_[0-9a-f-]{36}$/u.test(orderPublicId) || orderToken === null || orderToken.length < 20 || orderToken.length > 512 || grantToken === null || grantToken.length < 20 || grantToken.length > 512) {
      throw new AppError("private_download_grant_not_found", 404);
    }
    const result = await createWebsiteCommerceApplication(env, shop).consumePrivateDownloadGrant({
      actor: { kind: "anonymous" },
      channel: { code: WEBSITE_CHANNEL_CODE, connectionId: null },
      locale: locals.locale ?? normalizeSupportedLocale(shop.defaultLocale),
      requestId: locals.requestId,
      shopId: shop.id,
    }, {
      grantId: requireResourceId(params.grantId, "dgr"),
      grantToken,
      idempotencyKey,
      order: { access: { kind: "opaque_token", token: orderToken }, orderId: orderPublicId },
    });
    return new Response(result.bytes, {
      headers: {
        "Accept-Ranges": "none",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Content-Type": result.contentType,
        "Expires": "0",
        "Pragma": "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
