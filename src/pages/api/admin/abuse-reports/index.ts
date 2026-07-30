import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { listAdminAbuseReports, parseAbuseReportStatus } from "../../../../lib/operations/abuse";
import { getBindings } from "../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const url = new URL(request.url);
    const statusValue = url.searchParams.get("status");
    const result = await listAdminAbuseReports({
      cursor: url.searchParams.get("cursor"),
      env,
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
