import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../lib/auth/session";
import { AppError } from "../../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { listOwnerAbuseReports, parseAbuseReportStatus } from "../../../../../lib/operations/abuse";
import { getBindings } from "../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("tenant_not_found", 404);
    const url = new URL(request.url);
    const statusValue = url.searchParams.get("status");
    const result = await listOwnerAbuseReports({
      cursor: url.searchParams.get("cursor"),
      env,
      shopPublicId,
      status: statusValue === null || statusValue === "" ? null : parseAbuseReportStatus(statusValue),
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
