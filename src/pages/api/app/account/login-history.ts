import type { APIRoute } from "astro";

import { listLoginHistory } from "../../../../lib/auth/login-history";
import { requireCsrfSession } from "../../../../lib/auth/session";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, request, url }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "");
    const entries = await listLoginHistory({
      env,
      ...(Number.isSafeInteger(requestedLimit) ? { limit: requestedLimit } : {}),
      userId: auth.userId,
    });
    return Response.json({
      entries,
      ok: true,
      requestId: locals.requestId,
    }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
