import type { APIRoute } from "astro";

import { isAppError } from "../../../../lib/core/errors";
import { normalizeEmail } from "../../../../lib/auth/policy";
import { appendSessionCookies, completeRegistrationWithOtp, createPasswordResetToken } from "../../../../lib/auth/session";
import { verifyOtp, type OtpPurpose } from "../../../../lib/auth/otp";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { loggerFor } from "../../../../lib/operations/logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["email", "otp", "purpose"]);

    const email = normalizeEmail(body.email);
    const otp = typeof body.otp === "string" ? body.otp : "";
    const purpose = body.purpose as OtpPurpose;

    if (purpose === "register_verify") {
      const result = await completeRegistrationWithOtp({
        email,
        env,
        otp,
      });

      const headers = new Headers({
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Type": "application/json",
        "X-Robots-Tag": "noindex, nofollow",
      });

      appendSessionCookies(headers, result.credentials, env);

      return new Response(JSON.stringify({
        ok: true,
        requestId: locals.requestId,
        user: result.auth,
      }), {
        headers,
        status: 200,
      });
    }

    // Generic OTP verification (e.g. for step-up or validation before reset)
    const verified = await verifyOtp({
      email,
      env,
      otp,
      purpose,
    });

    const resetToken = purpose === "password_reset"
      ? await createPasswordResetToken(env.SESSION_SECRET, email, verified.userId)
      : undefined;

    return Response.json({
      message: "OTP verified successfully.",
      ok: true,
      requestId: locals.requestId,
      ...(resetToken ? { resetToken } : {}),
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
      event: "auth.otp_verify_failed",
      requestId: locals.requestId,
      source: "http",
    });

    return createCaughtErrorResponse(error, locals.requestId);
  }
};
