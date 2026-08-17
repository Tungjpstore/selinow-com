import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { guardAdminMutationRate } from "../../../../lib/http/admin-rate-limit";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { applyModerationAction, parseModerationActionKind } from "../../../../lib/operations/abuse";
import { getBindings } from "../../../../lib/platform/bindings";

function requireString(value: unknown, issue: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new AppError("validation_failed", 400, [issue]);
  }
  return value;
}

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    await guardAdminMutationRate({ env, family: "moderation", request });
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1_024);
    rejectUnknownFields(body, [
      "abuseReportPublicId",
      "actionKind",
      "reasonCode",
      "shopPublicId",
      "targetId",
    ]);
    const action = await applyModerationAction({
      actionKind: parseModerationActionKind(body.actionKind),
      actorScope: "platform_admin",
      actorUserId: auth.userId,
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      reasonCode: body.reasonCode,
      ...(body.abuseReportPublicId === undefined
        ? {}
        : { reportPublicId: requireString(body.abuseReportPublicId, "abuse_report_public_id_invalid") }),
      requestId: locals.requestId,
      shopPublicId: requireString(body.shopPublicId, "shop_public_id_invalid"),
      ...(body.targetId === undefined ? {} : { targetId: requireString(body.targetId, "target_id_invalid") }),
    });
    return Response.json({ action, ok: true, requestId: locals.requestId }, {
      status: 201,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
