import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { listAdminPaymentRemediationRequests } from "../../../../lib/payments/remediation";

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const status = new URL(request.url).searchParams.get("status");
    if (status !== null && status !== "" && !/^[a-z_]{3,32}$/u.test(status)) throw new AppError("validation_failed", 400, ["status_invalid"]);
    const requests = await listAdminPaymentRemediationRequests({ env, status, userId: auth.userId });
    return Response.json({ ok: true, requests, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
