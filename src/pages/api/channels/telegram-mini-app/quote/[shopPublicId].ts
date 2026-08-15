import type { APIRoute } from "astro";

import { authenticateTelegramMiniAppSession, readTelegramMiniAppBearerToken } from "../../../../../lib/channels/telegram-mini-app-session";
import { createTelegramMiniAppCartApplication, createTelegramMiniAppCommerceRuntime } from "../../../../../lib/channels/telegram-mini-app-commerce";
import { AppError } from "../../../../../lib/core/errors";
import type { CommerceQuoteCommand } from "../../../../../lib/commerce/contracts";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("resource_not_found", 404);
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (idempotencyKey === null) throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
    const env = getBindings();
    const session = await authenticateTelegramMiniAppSession({ env, sessionToken: readTelegramMiniAppBearerToken(request), shopPublicId });
    const runtime = await createTelegramMiniAppCommerceRuntime({ env, idempotencyKey, session });
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["cart"]);
    const view = await createTelegramMiniAppCartApplication({ env, idempotencyKey, runtime }).quoteCart(
      { ...runtime.context, requestId: idempotencyKey },
      body as unknown as CommerceQuoteCommand,
    );
    return Response.json({ ok: true, requestId: locals.requestId, quote: view }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
