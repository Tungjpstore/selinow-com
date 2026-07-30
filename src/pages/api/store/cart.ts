import type { APIRoute } from "astro";

import { WEBSITE_CHANNEL_CODE } from "../../../lib/channels/builtins";
import type { CommerceCartMutation, CommerceContext } from "../../../lib/commerce/contracts";
import { requireWebsiteCartReference } from "../../../lib/commerce/website-checkout-input";
import { createWebsiteCommerceApplication } from "../../../lib/commerce/website-port";
import { normalizeLocale, parseCartItems } from "../../../lib/commerce/policy";
import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { guardAnonymousCart } from "../../../lib/storefront/abuse";
import { assertStorefrontCheckout, resolveStorefrontShop, type StorefrontShop } from "../../../lib/storefront/store";

function websiteContext(input: {
  locale: string;
  requestId: string;
  shop: StorefrontShop;
}): CommerceContext {
  return {
    actor: { kind: "anonymous" },
    channel: { code: WEBSITE_CHANNEL_CODE, connectionId: null },
    locale: input.locale,
    requestId: input.requestId,
    shopId: input.shop.id,
  };
}

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    assertStorefrontCheckout(shop);
    await guardAnonymousCart({ env, request, shop });
    const body = await readJsonObject(request);
    const application = createWebsiteCommerceApplication(env, shop);
    const context = websiteContext({
      locale: normalizeLocale(body.locale ?? locals.locale, shop.defaultLocale),
      requestId: locals.requestId,
      shop,
    });

    if ("mutation" in body) {
      rejectUnknownFields(body, ["cartId", "cartToken", "locale", "mutation"]);
      const cart = requireWebsiteCartReference(body.cartId, body.cartToken);
      const result = await application.mutateCart(context, {
        cart: { access: { kind: "opaque_token", token: cart.cartToken }, cartId: cart.cartId },
        idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
        mutation: body.mutation as CommerceCartMutation,
      });
      if (result.cart.access.kind !== "opaque_token") throw new Error("website_cart_access_invalid");
      return Response.json({
        cartId: result.cart.cartId,
        cartToken: result.cart.access.token,
        ok: true,
        replayed: result.replayed,
        requestId: locals.requestId,
      }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
    }

    rejectUnknownFields(body, ["items", "locale"]);
    const cart = await application.createCart(context, { items: parseCartItems(body.items) });
    if (cart.access.kind !== "opaque_token") throw new Error("website_cart_access_invalid");
    return Response.json({ cartId: cart.cartId, cartToken: cart.access.token, expiresAt: cart.expiresAt, ok: true, requestId: locals.requestId }, { status: 201, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
