import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";
import { reconcilePayOSStagingUatAttempt } from "../../../../../../../lib/payments/staging-uat-reconciliation";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["paymentAttemptPublicId"]);
    if (typeof body.paymentAttemptPublicId !== "string") {
      throw new AppError("validation_failed", 400, ["payment_attempt_public_id_required"]);
    }
    const evidence = await reconcilePayOSStagingUatAttempt({
      attemptPublicId: requireResourceId(body.paymentAttemptPublicId, "pay"),
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ evidence, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
      status: evidence.replayed ? 200 : 201,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
