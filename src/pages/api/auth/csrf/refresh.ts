import type { APIRoute } from "astro";

import { assertDashboardOrigin } from "../../../../lib/auth/policy";
import { AppError } from "../../../../lib/core/errors";
import { appendCsrfCookie, authenticateRequest, csrfCookieMaxAgeForSession, rotateCsrfToken } from "../../../../lib/auth/session";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    // Recovery intentionally does not accept a CSRF token: it repairs that
    // token. Exact Origin plus the current session cookie remains mandatory.
    assertDashboardOrigin(request, env.DASHBOARD_ORIGIN);
    if (request.headers.get("Origin") !== env.DASHBOARD_ORIGIN) {
      throw new AppError("csrf_invalid", 403, ["origin_mismatch"]);
    }
    const auth = await authenticateRequest(request, env);
    const csrfToken = await rotateCsrfToken(auth, env);
    const response = Response.json({ ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
    appendCsrfCookie(response.headers, csrfToken, env, csrfCookieMaxAgeForSession(auth));
    return response;
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
