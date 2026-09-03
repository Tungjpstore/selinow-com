import type { APIRoute } from "astro";

import {
  appendClearedSessionCookies,
  listSessions,
  requireCsrfSession,
  requireRecentAuth,
  revokeAllSessions,
} from "../../../lib/auth/session";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const sessions = await listSessions(auth, env);
    return Response.json({ ok: true, requestId: locals.requestId, sessions }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const DELETE: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const revokedCount = await revokeAllSessions(auth, env);
    const response = Response.json(
      { ok: true, requestId: locals.requestId, revokedCount },
      { headers: PRIVATE_RESPONSE_HEADERS },
    );
    appendClearedSessionCookies(response.headers, env);
    return response;
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
