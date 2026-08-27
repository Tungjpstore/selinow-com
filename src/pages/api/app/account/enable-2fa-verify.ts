import type { APIRoute } from "astro";

import { AppError } from "../../../../lib/core/errors";
import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { confirmTwoFactorEnrollment } from "../../../../lib/auth/two-factor";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);

    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["otp"]);
    const otp = typeof body.otp === "string" ? body.otp : "";
    if (otp.length === 0 || otp.length > 16) {
      throw new AppError("validation_failed", 400, ["otp_invalid"]);
    }

    const result = await confirmTwoFactorEnrollment({ auth, env, otp });
    return Response.json({
      enabledAt: result.enabledAt,
      ok: true,
      requestId: locals.requestId,
    }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
