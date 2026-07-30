import type { APIRoute } from "astro";

import { WEBSITE_CHANNEL_CODE } from "../../../../lib/channels/builtins";
import { createWebsiteCommerceApplication } from "../../../../lib/commerce/website-port";
import { AppError } from "../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { normalizeSupportedLocale } from "../../../../lib/i18n/locale";
import { resolveStorefrontShop } from "../../../../lib/storefront/store";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    const orderPublicId = params.orderPublicId;
    const orderToken = request.headers.get("X-Order-Access-Token");
    if (orderPublicId === undefined || !/^order_[0-9a-f-]{36}$/u.test(orderPublicId) || orderToken === null || orderToken.length < 20) throw new AppError("order_not_found", 404);
    const order = await createWebsiteCommerceApplication(env, shop).getOrder({
      actor: { kind: "anonymous" },
      channel: { code: WEBSITE_CHANNEL_CODE, connectionId: null },
      locale: locals.locale ?? normalizeSupportedLocale(shop.defaultLocale),
      requestId: locals.requestId,
      shopId: shop.id,
    }, { order: { access: { kind: "opaque_token", token: orderToken }, orderId: orderPublicId } });
    return Response.json({ ok: true, order, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
