import type { APIRoute } from "astro";

import { isAppError } from "../../../../lib/core/errors";
import { normalizeEmail } from "../../../../lib/auth/policy";
import { createAndSendOtp, type OtpPurpose } from "../../../../lib/auth/otp";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { loggerFor } from "../../../../lib/operations/logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["email", "purpose"]);

    const email = normalizeEmail(body.email);
    const purpose = (body.purpose ?? "register_verify") as OtpPurpose;

    const result = await createAndSendOtp({
      email,
      env,
      locale: locals.locale,
      purpose,
    });

    return Response.json({
      cooldownSeconds: result.cooldownSeconds,
      ...(result.debugOtp ? { debugOtp: result.debugOtp } : {}),
      email,
      expiresAt: result.expiresAt,
      message: "New OTP has been sent to your email.",
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
      event: "auth.otp_resend_failed",
      requestId: locals.requestId,
      source: "http",
    });

    return createCaughtErrorResponse(error, locals.requestId);
  }
};
