import type { APIRoute } from "astro";

import { AppError } from "../../../../lib/core/errors";
import { changePassword } from "../../../../lib/auth/password";
import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);

    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["currentPassword", "newPassword"]);
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (currentPassword.length === 0 || currentPassword.length > 128
      || newPassword.length === 0 || newPassword.length > 128) {
      throw new AppError("validation_failed", 400, ["password_fields_required"]);
    }

    const result = await changePassword({
      auth,
      currentPassword,
      env,
      locale: locals.locale,
      newPassword,
    });
    return Response.json({
      ok: true,
      requestId: locals.requestId,
      revokedSessionCount: result.revokedSessionCount,
    }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
