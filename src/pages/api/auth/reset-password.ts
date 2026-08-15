import type { APIRoute } from "astro";

import { isAppError } from "../../../lib/core/errors";
import { normalizeEmail } from "../../../lib/auth/policy";
import { resetPasswordWithOtp } from "../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { loggerFor } from "../../../lib/operations/logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["email", "otp", "resetToken", "newPassword"]);

    const email = normalizeEmail(body.email);
    const otp = typeof body.otp === "string" ? body.otp : undefined;
    const resetToken = typeof body.resetToken === "string" ? body.resetToken : undefined;
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    await resetPasswordWithOtp({
      email,
      env,
      ...(locals.locale === undefined ? {} : { locale: locals.locale }),
      newPassword,
      ...(otp === undefined ? {} : { otp }),
      ...(resetToken === undefined ? {} : { resetToken }),
    });


    return Response.json({
      message: "Password reset successful. You can now log in with your new password.",
      ok: true,
      requestId: locals.requestId,
    }, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
      status: 200,
    });
  } catch (error) {
    const failure = isAppError(error)
      ? { errorCode: error.code, status: error.status }
      : { errorCode: "internal_error", status: 500 };

    loggerFor(env).warn({
      ...failure,
      event: "auth.reset_password_failed",
      requestId: locals.requestId,
      source: "http",
    });

    return createCaughtErrorResponse(error, locals.requestId);
  }
};
