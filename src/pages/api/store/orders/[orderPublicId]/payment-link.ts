import type { APIRoute } from "astro";

import { WEBSITE_CHANNEL_CODE } from "../../../../../lib/channels/builtins";
import { createWebsiteCommerceApplication } from "../../../../../lib/commerce/website-port";
import { AppError } from "../../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";
import { normalizeSupportedLocale } from "../../../../../lib/i18n/locale";
import { assertStorefrontCheckout, resolveStorefrontShop } from "../../../../../lib/storefront/store";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    assertStorefrontCheckout(shop);
    const orderPublicId = params.orderPublicId;
    const orderToken = request.headers.get("X-Order-Access-Token");
    if (orderPublicId === undefined || !/^order_[0-9a-f-]{36}$/u.test(orderPublicId) || orderToken === null || orderToken.length < 20) throw new AppError("order_not_found", 404);
    const handoff = await createWebsiteCommerceApplication(env, shop).createPaymentHandoff({
      actor: { kind: "anonymous" },
      channel: { code: WEBSITE_CHANNEL_CODE, connectionId: null },
      locale: locals.locale ?? normalizeSupportedLocale(shop.defaultLocale),
      requestId: locals.requestId,
      shopId: shop.id,
    }, {
      order: { access: { kind: "opaque_token", token: orderToken }, orderId: orderPublicId },
      origin: new URL(request.url).origin,
    });
    const paymentLink = {
      checkoutUrl: handoff.redirectUrl,
      expiresAt: handoff.expiresAt,
      paymentAttemptId: handoff.handoffId,
      qrCode: handoff.presentation?.payload ?? "",
      state: handoff.status,
    };
    return Response.json({ ok: true, paymentLink, requestId: locals.requestId }, { status: 201, headers: { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
