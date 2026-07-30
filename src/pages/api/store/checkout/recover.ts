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
import { resolveStorefrontShop } from "../../../../lib/storefront/store";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["cartId", "cartToken", "customerEmail", "expected", "idempotencyKey", "recoveryEvidence"]);
    const cart = requireWebsiteCartReference(body.cartId, body.cartToken);
    const order = await createWebsiteCommerceApplication(env, shop).recoverCheckout({
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
      recoveryEvidence: requireWebsiteEvidence(body.recoveryEvidence, "checkout_recovery_invalid"),
    });
    return Response.json({ ok: true, order: {
      currency: order.currency,
      expiresAt: order.expiresAt,
      fulfillmentStatus: order.fulfillmentStatus,
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      orderToken: order.access.token,
      paymentStatus: order.paymentStatus,
      status: order.status,
      totalMinor: order.totalMinor,
    }, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
