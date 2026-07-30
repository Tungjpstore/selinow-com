import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const auth = await authenticateRequest(request, getBindings());
    return Response.json({
      ok: true,
      requestId: locals.requestId,
      user: { displayName: auth.displayName, email: auth.email },
    }, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
