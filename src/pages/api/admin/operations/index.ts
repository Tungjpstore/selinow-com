import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { listActiveDeadLetters } from "../../../../lib/operations/dead-letters";
import { listActiveDeletionRequests } from "../../../../lib/operations/deletion";
import { listActiveIncidents } from "../../../../lib/operations/incidents";
import { getBindings } from "../../../../lib/platform/bindings";
import { isPlatformAdmin } from "../../../../lib/tenants/store";

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    if (!(await isPlatformAdmin({ env, userId: auth.userId }))) {
      throw new AppError("authorization_denied", 403);
    }
    const [deadLetters, deletionOverview, incidents] = await Promise.all([
      listActiveDeadLetters({ env }),
      listActiveDeletionRequests({ env, userId: auth.userId }),
      listActiveIncidents({ env }),
    ]);
    return Response.json({ deadLetters, deletionOverview, incidents, ok: true, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
