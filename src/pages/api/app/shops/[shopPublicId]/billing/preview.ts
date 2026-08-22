import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../../lib/auth/session";
import { previewSellerPlanChange } from "../../../../../../lib/billing/service";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["planCode"]);
    if (body.planCode !== "starter" && body.planCode !== "pro") throw new AppError("validation_failed", 400, ["plan_code_invalid"]);
    const preview = await previewSellerPlanChange({
      env,
      fetcher: fetch,
      planCode: body.planCode,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ok: true, preview, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
