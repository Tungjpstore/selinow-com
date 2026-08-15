import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { createSubscriptionChangeRequest, listSubscriptionChangeRequests } from "../../../../../../lib/tenants/billing-requests";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const requests = await listSubscriptionChangeRequests({ env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ ok: true, requests, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["action", "expectedSubscriptionVersion", "reasonCode", "requestedPlanCode"]);
    if (typeof body.action !== "string") throw new AppError("validation_failed", 400, ["billing_action_required"]);
    const result = await createSubscriptionChangeRequest({
      action: body.action as "cancel" | "change_plan" | "resume",
      env,
      expectedSubscriptionVersion: body.expectedSubscriptionVersion as number,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      ...(Object.hasOwn(body, "requestedPlanCode") ? { requestedPlanCode: body.requestedPlanCode } : {}),
      reasonCode: body.reasonCode,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ok: true, request: result, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS, status: 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
