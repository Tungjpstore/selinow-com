import type { APIRoute } from "astro";

import { authenticateTelegramMiniAppSession, readTelegramMiniAppBearerToken } from "../../../../../lib/channels/telegram-mini-app-session";
import { createTelegramMiniAppCheckoutApplication, createTelegramMiniAppCommerceRuntime } from "../../../../../lib/channels/telegram-mini-app-commerce";
import { AppError } from "../../../../../lib/core/errors";
import { resolveTelegramCheckoutSnapshot } from "../../../../../lib/commerce/telegram-port";
import type { CommerceCheckoutCommand } from "../../../../../lib/commerce/contracts";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("resource_not_found", 404);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["cart", "customerEmail", "expected", "idempotencyKey", "quoteEvidence"]);
    const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    const headerKey = request.headers.get("Idempotency-Key");
    if (bodyKey === null || headerKey === null || bodyKey !== headerKey) throw new AppError("validation_failed", 400, ["idempotency_key_mismatch"]);
    const env = getBindings();
    const session = await authenticateTelegramMiniAppSession({ env, sessionToken: readTelegramMiniAppBearerToken(request), shopPublicId });
    const runtime = await createTelegramMiniAppCommerceRuntime({ env, idempotencyKey: bodyKey, session });
    const cart = (body.cart as { cartId?: unknown } | undefined);
    const cartId = cart !== undefined && typeof cart.cartId === "string" ? cart.cartId : undefined;
    if (cartId === undefined) throw new AppError("validation_failed", 400, ["cart_id_invalid"]);
    const snapshot = await resolveTelegramCheckoutSnapshot({
      checkoutKey: bodyKey,
      connectionId: runtime.context.channel.connectionId,
      env,
      identity: runtime.identity,
      quotedCartId: cartId,
      shop: runtime.shop,
    });
    const application = createTelegramMiniAppCheckoutApplication({ env, idempotencyKey: bodyKey, requestedSnapshot: snapshot, runtime });
    const view = await application.checkoutCart({ ...runtime.context, requestId: bodyKey }, body as unknown as CommerceCheckoutCommand);
    return Response.json({ ok: true, requestId: locals.requestId, order: view }, { headers: PRIVATE_RESPONSE_HEADERS, status: 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
