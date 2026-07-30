import type { APIRoute } from "astro";

import { WEBSITE_CHANNEL_CODE } from "../../../../lib/channels/builtins";
import { createWebsiteCommerceApplication } from "../../../../lib/commerce/website-port";
import { normalizeCustomerEmail } from "../../../../lib/commerce/policy";
import {
  parseWebsiteCheckoutExpected,
  requireWebsiteCartReference,
  requireWebsiteCheckoutIdempotencyKey,
  requireWebsiteEvidence,
} from "../../../../lib/commerce/website-checkout-input";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { normalizeSupportedLocale } from "../../../../lib/i18n/locale";
import { assertStorefrontCheckout, resolveStorefrontShop } from "../../../../lib/storefront/store";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    assertStorefrontCheckout(shop);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["cartId", "cartToken", "customerEmail", "expected", "idempotencyKey", "quoteEvidence"]);
    const cart = requireWebsiteCartReference(body.cartId, body.cartToken);
    const recovery = await createWebsiteCommerceApplication(env, shop).prepareCheckoutRecovery({
      actor: { kind: "anonymous" },
      channel: { code: WEBSITE_CHANNEL_CODE, connectionId: null },
      locale: locals.locale ?? normalizeSupportedLocale(shop.defaultLocale),
      requestId: locals.requestId,
      shopId: shop.id,
    }, {
      cart: { access: { kind: "opaque_token", token: cart.cartToken }, cartId: cart.cartId },
      customerEmail: normalizeCustomerEmail(body.customerEmail),
      expected: parseWebsiteCheckoutExpected(body.expected),
      idempotencyKey: requireWebsiteCheckoutIdempotencyKey(body.idempotencyKey),
      quoteEvidence: requireWebsiteEvidence(body.quoteEvidence, "quote_invalid"),
    });
    return Response.json({ ok: true, recovery, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
