import type { APIRoute } from "astro";

import { WEBSITE_CHANNEL_CODE } from "../../../lib/channels/builtins";
import { AppError } from "../../../lib/core/errors";
import { createWebsiteCommerceApplication } from "../../../lib/commerce/website-port";
import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { normalizeSupportedLocale } from "../../../lib/i18n/locale";
import { assertStorefrontCheckout, resolveStorefrontShop } from "../../../lib/storefront/store";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    assertStorefrontCheckout(shop);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["cartId", "cartToken", "shippingMethodId"]);
    if (typeof body.cartId !== "string" || !/^cart_[0-9a-f-]{36}$/u.test(body.cartId) || typeof body.cartToken !== "string" || body.cartToken.length < 20) throw new AppError("cart_not_found", 404);
    if (body.shippingMethodId !== undefined && (typeof body.shippingMethodId !== "string" || body.shippingMethodId.length > 64)) throw new AppError("validation_failed", 400, ["shipping_method_invalid"]);
    const quote = await createWebsiteCommerceApplication(env, shop).quoteCart({
      actor: { kind: "anonymous" },
      channel: { code: WEBSITE_CHANNEL_CODE, connectionId: null },
      locale: locals.locale ?? normalizeSupportedLocale(shop.defaultLocale),
      requestId: locals.requestId,
      shopId: shop.id,
    }, {
      cart: { access: { kind: "opaque_token", token: body.cartToken }, cartId: body.cartId },
      ...(body.shippingMethodId === undefined ? {} : { shippingMethodId: body.shippingMethodId }),
    });
    return Response.json({ ok: true, quote, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
