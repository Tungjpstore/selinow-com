import type { APIRoute } from "astro";

import { cloudflareRequesterAddress } from "../../../../lib/auth/admission";
import { googleTwoFactorCookieName } from "../../../../lib/auth/google";
import { appendSessionCookies, completeTwoFactorLogin } from "../../../../lib/auth/session";
import { AppError, isAppError } from "../../../../lib/core/errors";
import { clearCookie, parseCookies } from "../../../../lib/http/cookies";
import { assertDashboardOrigin } from "../../../../lib/auth/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    assertDashboardOrigin(request, env.DASHBOARD_ORIGIN);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["otp"]);
    const challengeToken = parseCookies(request.headers.get("Cookie")).get(googleTwoFactorCookieName(env)) ?? "";
    if (challengeToken.length < 10 || challengeToken.length > 1_024) throw new AppError("authentication_required", 401);
    const otp = typeof body.otp === "string" ? body.otp : "";
    const result = await completeTwoFactorLogin({ challengeToken, env, otp, requesterAddress: cloudflareRequesterAddress(request) });
    const headers = new Headers({ "Cache-Control": "private, no-store, max-age=0", "Content-Type": "application/json", "X-Robots-Tag": "noindex, nofollow" });
    headers.append("Set-Cookie", clearCookie(googleTwoFactorCookieName(env), env.APP_ENV !== "local", true));
    appendSessionCookies(headers, result.credentials, env);
    return new Response(JSON.stringify({ ok: true, requestId: locals.requestId, user: result.auth }), { headers, status: 200 });
  } catch (error) {
    const response = createCaughtErrorResponse(error, locals.requestId);
    if (isAppError(error) && (error.code === "authentication_required" || error.issues?.includes("two_factor_challenge_expired") === true)) {
      response.headers.append("Set-Cookie", clearCookie(googleTwoFactorCookieName(env), env.APP_ENV !== "local", true));
    }
    return response;
  }
};
