import type { APIRoute } from "astro";

import { AppError } from "../../../../../lib/core/errors";
import { authenticateTelegramMiniAppSession, readTelegramMiniAppBearerToken } from "../../../../../lib/channels/telegram-mini-app-session";
import { getTelegramMiniAppCatalog } from "../../../../../lib/channels/telegram-mini-app-catalog";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("resource_not_found", 404);
    const env = getBindings();
    const session = await authenticateTelegramMiniAppSession({
      env,
      sessionToken: readTelegramMiniAppBearerToken(request),
      shopPublicId,
    });
    const catalog = await getTelegramMiniAppCatalog({ env, shopId: session.shopId });
    return Response.json({ catalog, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
