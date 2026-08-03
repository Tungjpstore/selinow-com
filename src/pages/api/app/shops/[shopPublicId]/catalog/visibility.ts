import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { setCatalogChannelVisibility, listCatalogChannelVisibility } from "../../../../../../lib/catalog/channel-visibility";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const visibility = await listCatalogChannelVisibility({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, visibility }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["channelCode", "expectedVersion", "productId", "visible"]);
    if (typeof body.channelCode !== "string" || typeof body.productId !== "string"
      || typeof body.expectedVersion !== "number" || typeof body.visible !== "boolean") {
      throw new AppError("validation_failed", 400, ["catalog_visibility_fields_required"]);
    }
    const channelCode = body.channelCode;
    const expectedVersion = body.expectedVersion;
    const productId = body.productId;
    const visible = body.visible;
    const result = await setCatalogChannelVisibility({
      channelCode,
      env,
      expectedVersion,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      productId,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
      visible,
    });
    return Response.json({ ok: true, projection: result.projection, replayed: result.replayed, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
