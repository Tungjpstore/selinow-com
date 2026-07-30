import type { APIRoute } from "astro";

import { getAutomationTask } from "../../../../../../lib/automation/api-service";
import { authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function requireTaskId(value: string | undefined): string {
  if (value === undefined || value === "") throw new AppError("resource_not_found", 404);
  return value;
}

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const result = await getAutomationTask({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      taskId: requireTaskId(params.taskId),
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
