import type { APIRoute } from "astro";

import { appendClearedSessionCookies, requireCsrfSession, revokeSession } from "../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    await revokeSession(auth, env);
    const response = Response.json({ ok: true, requestId: locals.requestId });
    appendClearedSessionCookies(response.headers, env);
    return response;
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
