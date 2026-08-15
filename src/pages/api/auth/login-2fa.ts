import type { APIRoute } from "astro";

import { cloudflareRequesterAddress } from "../../../lib/auth/admission";
import { AppError, isAppError } from "../../../lib/core/errors";
import { appendSessionCookies, completeTwoFactorLogin } from "../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { loggerFor } from "../../../lib/operations/logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["challengeToken", "otp"]);

    const challengeToken = typeof body.challengeToken === "string" ? body.challengeToken : "";
    const otp = typeof body.otp === "string" ? body.otp : "";
    if (challengeToken.length < 10 || challengeToken.length > 1_024) {
      throw new AppError("validation_failed", 400, ["challenge_token_invalid"]);
    }

    const result = await completeTwoFactorLogin({
      challengeToken,
      env,
      otp,
      requesterAddress: cloudflareRequesterAddress(request),
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
  } catch (error) {
    const failure = isAppError(error)
      ? { errorCode: error.code, status: error.status }
      : { errorCode: "internal_error", status: 500 };

    loggerFor(env).warn({
      ...failure,
      event: "auth.two_factor_login_failed",
      requestId: locals.requestId,
      source: "http",
    });

    return createCaughtErrorResponse(error, locals.requestId);
  }
};
