import type { APIRoute } from "astro";

import { isAppError } from "../../../lib/core/errors";
import { claimOtpAdmission, cloudflareRequesterAddress } from "../../../lib/auth/admission";
import { normalizeEmail } from "../../../lib/auth/policy";
import { requestPasswordResetOtp } from "../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { loggerFor } from "../../../lib/operations/logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["email"]);

    const email = normalizeEmail(body.email);
    await claimOtpAdmission({
      email,
      env,
      now: new Date(),
      purpose: "password_reset",
      requesterAddress: cloudflareRequesterAddress(request),
    });
    const result = await requestPasswordResetOtp({
      email,
      env,
      locale: locals.locale,
    });

    return Response.json({
      cooldownSeconds: result.cooldownSeconds,
      ...(result.debugOtp ? { debugOtp: result.debugOtp } : {}),
      email,
      expiresAt: result.expiresAt,
      message: "If this email is registered, a password reset code has been sent.",
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
      event: "auth.forgot_password_failed",
      requestId: locals.requestId,
      source: "http",
    });

    return createCaughtErrorResponse(error, locals.requestId);
  }
};
