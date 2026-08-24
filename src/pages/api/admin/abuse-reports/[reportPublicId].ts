import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { guardAdminMutationRate } from "../../../../lib/http/admin-rate-limit";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { parseAbuseReportStatus, transitionAbuseReport } from "../../../../lib/operations/abuse";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    await guardAdminMutationRate({ env, family: "abuse_reports", request });
    requireRecentAuth(auth, 5);
    const reportPublicId = params.reportPublicId;
    if (reportPublicId === undefined || !/^abr_[A-Za-z0-9_-]{20,64}$/u.test(reportPublicId)) {
      throw new AppError("abuse_report_not_found", 404);
    }
    const body = await readJsonObject(request, 2 * 1_024);
    rejectUnknownFields(body, ["status"]);
    const report = await transitionAbuseReport({
      adminUserId: auth.userId,
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      reportPublicId,
      requestId: locals.requestId,
      status: parseAbuseReportStatus(body.status),
    });
    return Response.json({ ok: true, report, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
