import type { APIRoute } from "astro";

import { authenticateTelegramMiniAppSession, readTelegramMiniAppBearerToken } from "../../../../../lib/channels/telegram-mini-app-session";
import { createTelegramMiniAppCommerceRuntime } from "../../../../../lib/channels/telegram-mini-app-commerce";
import { AppError } from "../../../../../lib/core/errors";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("resource_not_found", 404);
    const env = getBindings();
    const session = await authenticateTelegramMiniAppSession({ env, sessionToken: readTelegramMiniAppBearerToken(request), shopPublicId });
    const runtime = await createTelegramMiniAppCommerceRuntime({ env, idempotencyKey: null, session });
    const orders = await runtime.orderApplication.listOrders(runtime.context, {});
    return Response.json({ ok: true, requestId: locals.requestId, orders }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
