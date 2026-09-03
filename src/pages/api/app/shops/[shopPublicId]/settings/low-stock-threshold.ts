import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { updateShopLowStockThreshold } from "../../../../../../lib/tenants/storefront-settings";

export const PUT: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["expectedVersion", "threshold"]);
    if (typeof body.threshold !== "number") {
      throw new AppError("validation_failed", 400, ["low_stock_threshold_invalid"]);
    }
    if (body.expectedVersion !== undefined && typeof body.expectedVersion !== "number") {
      throw new AppError("validation_failed", 400, ["storefront_version_invalid"]);
    }
    // The Idempotency-Key header is required by contract for seller settings
    // writes; the optimistic version guard (or last-writer-wins fallback)
    // keeps retries safe at the storage layer.
    if (request.headers.get("Idempotency-Key") === null) {
      throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
    }
    const result = await updateShopLowStockThreshold({
      env,
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      threshold: body.threshold,
      userId: auth.userId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, ...result }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
