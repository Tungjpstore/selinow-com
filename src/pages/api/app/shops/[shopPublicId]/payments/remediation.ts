import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { createPaymentRemediationRequest, listSellerPaymentRemediationRequests } from "../../../../../../lib/payments/remediation";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const requests = await listSellerPaymentRemediationRequests({ env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
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
    rejectUnknownFields(body, ["amountMinor", "currency", "exceptionPublicId", "kind", "reasonCode"]);
    if (typeof body.exceptionPublicId !== "string" || typeof body.kind !== "string" || typeof body.currency !== "string") {
      throw new AppError("validation_failed", 400, ["remediation_fields_required"]);
    }
    const result = await createPaymentRemediationRequest({
      amountMinor: body.amountMinor as number,
      currency: body.currency,
      env,
      exceptionPublicId: body.exceptionPublicId,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      kind: body.kind as "manual_review" | "partial_refund" | "refund",
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
