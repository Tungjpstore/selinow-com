import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../lib/auth/session";
import { AppError } from "../../../../../lib/core/errors";
import { guardAdminMutationRate } from "../../../../../lib/http/admin-rate-limit";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { applyModerationAction } from "../../../../../lib/operations/abuse";
import { getBindings } from "../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    await guardAdminMutationRate({ env, family: "shops", request });
    requireRecentAuth(auth);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["abuseReportPublicId", "reasonCode"]);
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) {
      throw new AppError("tenant_not_found", 404);
    }
    const action = await applyModerationAction({
      actionKind: "shop_suspend",
      actorScope: "platform_admin",
      actorUserId: auth.userId,
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      reasonCode: body.reasonCode,
      ...(typeof body.abuseReportPublicId === "string"
        ? { reportPublicId: body.abuseReportPublicId }
        : {}),
      requestId: locals.requestId,
      shopPublicId,
    });
    return Response.json({ action, ok: true, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
