import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { listAdminAuditEntries } from "../../../../lib/operations/admin-investigations";

function parseLimit(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  if (!/^\d{1,2}$/u.test(value)) throw new AppError("validation_failed", 400, ["limit_invalid"]);
  return Number(value);
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const result = await listAdminAuditEntries({
      env,
      filters: {
        action: url.searchParams.get("action"),
        cursor: url.searchParams.get("cursor"),
        ...(limit === undefined ? {} : { limit }),
        resourceType: url.searchParams.get("resourceType"),
        shopPublicId: url.searchParams.get("shopPublicId"),
      },
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
