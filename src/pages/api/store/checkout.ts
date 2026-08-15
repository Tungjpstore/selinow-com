import type { APIRoute } from "astro";

import { WEBSITE_CHANNEL_CODE } from "../../../lib/channels/builtins";
import { createWebsiteCommerceApplication } from "../../../lib/commerce/website-port";
import { normalizeCustomerEmail } from "../../../lib/commerce/policy";
import { AppError } from "../../../lib/core/errors";
import { parseWebsiteCheckoutExpected, requireWebsiteCartReference } from "../../../lib/commerce/website-checkout-input";
import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { guardAnonymousCheckout } from "../../../lib/storefront/abuse";
import { normalizeSupportedLocale } from "../../../lib/i18n/locale";
import { assertStorefrontCheckout, resolveStorefrontShop } from "../../../lib/storefront/store";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    assertStorefrontCheckout(shop);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["cartId", "cartToken", "customerEmail", "expected", "quoteEvidence", "shipping", "turnstileToken"]);
    await guardAnonymousCheckout({ env, request, shop, turnstileToken: body.turnstileToken });
    const cart = requireWebsiteCartReference(body.cartId, body.cartToken);
    if (typeof body.quoteEvidence !== "string" || body.quoteEvidence.length < 40 || body.quoteEvidence.length > 4_096) throw new AppError("quote_invalid", 409);
    if (body.shipping !== undefined && (typeof body.shipping !== "object" || body.shipping === null || Array.isArray(body.shipping))) throw new AppError("validation_failed", 400, ["shipping_address_invalid"]);
    const shipping = body.shipping === undefined ? undefined : body.shipping as { address?: unknown; methodId?: unknown };
    const order = await createWebsiteCommerceApplication(env, shop).checkoutCart({
      actor: { kind: "anonymous" },
      channel: { code: WEBSITE_CHANNEL_CODE, connectionId: null },
      locale: locals.locale ?? normalizeSupportedLocale(shop.defaultLocale),
      requestId: locals.requestId,
      shopId: shop.id,
    }, {
      cart: { access: { kind: "opaque_token", token: cart.cartToken }, cartId: cart.cartId },
      customerEmail: normalizeCustomerEmail(body.customerEmail),
      expected: parseWebsiteCheckoutExpected(body.expected),
      idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
      quoteEvidence: body.quoteEvidence,
      ...(shipping === undefined ? {} : { shipping: { address: shipping.address, methodId: shipping.methodId } }),
    });
    if (order.access.kind !== "opaque_token") throw new AppError("commerce_contract_invalid", 500, ["website_order_access_invalid"]);
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
    }, requestId: locals.requestId }, { status: 201, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
