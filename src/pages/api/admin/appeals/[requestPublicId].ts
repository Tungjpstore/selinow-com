import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { requireResourceId } from "../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { reviewPaymentRemediationRequest } from "../../../../lib/payments/remediation";

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["decision", "expectedVersion"]);
    const result = await reviewPaymentRemediationRequest({
      decision: body.decision as "provider_pending" | "rejected",
      env,
      expectedVersion: body.expectedVersion as number,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      requestPublicId: requireResourceId(params.requestPublicId, "prem"),
      requestId: locals.requestId,
      userId: auth.userId,
    });
    return Response.json({ ok: true, request: result, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
