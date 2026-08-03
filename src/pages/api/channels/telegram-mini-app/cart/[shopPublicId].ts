import type { APIRoute } from "astro";

import { authenticateTelegramMiniAppSession, readTelegramMiniAppBearerToken } from "../../../../../lib/channels/telegram-mini-app-session";
import { createTelegramMiniAppCartApplication, createTelegramMiniAppCommerceRuntime } from "../../../../../lib/channels/telegram-mini-app-commerce";
import { AppError } from "../../../../../lib/core/errors";
import type { CommerceCartMutationCommand, CommerceCreateCartCommand } from "../../../../../lib/commerce/contracts";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

async function runtime(request: Request, shopPublicId: string, idempotencyKey: string | null) {
  const env = getBindings();
  const session = await authenticateTelegramMiniAppSession({ env, sessionToken: readTelegramMiniAppBearerToken(request), shopPublicId });
  return { env, runtime: await createTelegramMiniAppCommerceRuntime({ env, idempotencyKey, session }) };
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("resource_not_found", 404);
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (idempotencyKey === null) throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
    const resolved = await runtime(request, shopPublicId, idempotencyKey);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["items"]);
    const view = await createTelegramMiniAppCartApplication({ env: resolved.env, idempotencyKey, runtime: resolved.runtime }).createCart(
      { ...resolved.runtime.context, requestId: idempotencyKey },
      body as unknown as CommerceCreateCartCommand,
    );
    return Response.json({ ok: true, requestId: locals.requestId, cart: view }, { headers: PRIVATE_RESPONSE_HEADERS, status: 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("resource_not_found", 404);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["cart", "idempotencyKey", "mutation"]);
    const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    const headerKey = request.headers.get("Idempotency-Key");
    if (bodyKey === null || headerKey === null || bodyKey !== headerKey) throw new AppError("validation_failed", 400, ["idempotency_key_mismatch"]);
    const resolved = await runtime(request, shopPublicId, headerKey);
    const view = await createTelegramMiniAppCartApplication({ env: resolved.env, idempotencyKey: headerKey, runtime: resolved.runtime }).mutateCart(
      { ...resolved.runtime.context, requestId: headerKey },
      body as unknown as CommerceCartMutationCommand,
    );
    return Response.json({ ok: true, requestId: locals.requestId, ...view }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
