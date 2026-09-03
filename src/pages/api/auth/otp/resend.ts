import type { APIRoute } from "astro";

import { AppError, isAppError } from "../../../../lib/core/errors";
import { claimOtpAdmission, cloudflareRequesterAddress } from "../../../../lib/auth/admission";
import { normalizeEmail } from "../../../../lib/auth/policy";
import { googleTwoFactorCookieName } from "../../../../lib/auth/google";
import { requestPasswordResetOtp, resendRegistrationOtp, resendTwoFactorLoginOtp } from "../../../../lib/auth/session";
import { parseCookies } from "../../../../lib/http/cookies";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { loggerFor } from "../../../../lib/operations/logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["email", "purpose", "challengeToken"]);

    const purpose = body.purpose ?? "register_verify";
    if (purpose !== "register_verify" && purpose !== "password_reset" && purpose !== "login_2fa") {
      throw new AppError("validation_failed", 400, ["otp_purpose_invalid"]);
    }

    let result: { cooldownSeconds: number; debugOtp?: string; expiresAt: string };
    let email: string | undefined;
    if (purpose === "login_2fa") {
      const cookieChallenge = parseCookies(request.headers.get("Cookie")).get(googleTwoFactorCookieName(env));
      const challengeToken = typeof body.challengeToken === "string" && body.challengeToken.length > 0
        ? body.challengeToken
        : cookieChallenge ?? "";
      if (challengeToken.length < 10 || challengeToken.length > 1_024) {
        throw new AppError("authentication_required", 401);
      }
      result = await resendTwoFactorLoginOtp({ challengeToken, env, locale: locals.locale });
    } else {
      email = normalizeEmail(body.email);
      await claimOtpAdmission({
        email,
        env,
        now: new Date(),
        purpose,
        requesterAddress: cloudflareRequesterAddress(request),
      });
      result = purpose === "register_verify"
        ? await resendRegistrationOtp({ email, env, locale: locals.locale })
        : await requestPasswordResetOtp({ email, env, locale: locals.locale });
    }

    return Response.json({
      cooldownSeconds: result.cooldownSeconds,
      ...(result.debugOtp ? { debugOtp: result.debugOtp } : {}),
      ...(email === undefined ? {} : { email }),
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
