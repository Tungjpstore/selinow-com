import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { createBillingCheckout } from "../../../../../../lib/billing/service";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["planCode", "recovery"]);
    if (body.recovery !== undefined && typeof body.recovery !== "boolean") throw new AppError("validation_failed", 400, ["recovery_invalid"]);
    const result = await createBillingCheckout({
      env,
      fetcher: fetch,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      planCode: body.planCode,
      ...(body.recovery === true ? { recovery: true } : {}),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ checkout: result, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS, status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
