import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { applyModerationAction, parseModerationActionKind } from "../../../../../../lib/operations/abuse";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("tenant_not_found", 404);
    const body = await readJsonObject(request, 4 * 1_024);
    rejectUnknownFields(body, ["abuseReportPublicId", "actionKind", "reasonCode", "targetId"]);
    const actionKind = parseModerationActionKind(body.actionKind);
    if (!actionKind.startsWith("product_")) throw new AppError("authorization_denied", 403);
    const action = await applyModerationAction({
      actionKind,
      actorScope: "shop_owner",
      actorUserId: auth.userId,
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      reasonCode: body.reasonCode,
      ...(typeof body.abuseReportPublicId === "string"
        ? { reportPublicId: body.abuseReportPublicId }
        : {}),
      requestId: locals.requestId,
      shopPublicId,
      ...(typeof body.targetId === "string" ? { targetId: body.targetId } : {}),
    });
    return Response.json({ action, ok: true, requestId: locals.requestId }, {
      status: 201,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
