import type { APIRoute } from "astro";

import { cloudflareRequesterAddress } from "../../../../lib/auth/admission";
import { consumeGoogleOAuthState, exchangeAndVerifyGoogleCode, googleAuthorizationError, googleStateCookieName, googleTwoFactorCookieName, resolveGoogleIdentity, revokeGoogleOAuthState } from "../../../../lib/auth/google";
import { recordLoginHistory } from "../../../../lib/auth/login-history";
import { appendSessionCookies, authenticateRequest, issueSessionForUserId, issueTwoFactorChallengeForUser, requireRecentAuth } from "../../../../lib/auth/session";
import { AppError, isAppError } from "../../../../lib/core/errors";
import { safeRelativeRedirect } from "../../../../lib/auth/redirect";
import { clearCookie, parseCookies, serializeCookie } from "../../../../lib/http/cookies";
import { getBindings } from "../../../../lib/platform/bindings";

function privateRedirect(location: string, headers?: Headers): Response {
  const result = headers ?? new Headers();
  result.set("Cache-Control", "private, no-store, max-age=0");
  result.set("Location", location);
  result.set("Referrer-Policy", "no-referrer");
  result.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(null, { headers: result, status: 303 });
}

function errorRedirect(env: ReturnType<typeof getBindings>, code: string, flow: string | null): string {
  const page = flow === "link" ? "/app/security?tab=sessions" : flow === "register" ? "/register" : "/login";
  const url = new URL(page, env.DASHBOARD_ORIGIN);
  url.searchParams.set("google_error", code);
  return url.toString();
}

function appendClearedStateCookie(headers: Headers, env: ReturnType<typeof getBindings>): void {
  headers.append("Set-Cookie", clearCookie(googleStateCookieName(env), env.APP_ENV !== "local", true));
}

function callbackErrorCode(error: unknown): string {
  if (!isAppError(error)) return "google_failed";
  if (error.code === "google_account_link_required" || error.code === "google_account_not_found"
    || error.code === "google_already_linked" || error.code === "google_identity_in_use") return error.code;
  if (error.code.startsWith("google_oauth_state_") || error.code === "google_oauth_browser_mismatch"
    || error.code === "google_oauth_invalid") return "state_invalid";
  if (error.code === "google_oauth_provider_failed") {
    return error.issues?.includes("email_not_verified") === true ? "email_not_verified" : "provider_unavailable";
  }
  return "google_failed";
}

function localBridge(requestUrl: URL, env: ReturnType<typeof getBindings>): Response | null {
  if (env.APP_ENV !== "local" || requestUrl.origin === env.DASHBOARD_ORIGIN) return null;
  const redirectUri = new URL(env.GOOGLE_OAUTH_REDIRECT_URI);
  if (requestUrl.origin !== redirectUri.origin || requestUrl.pathname !== redirectUri.pathname) return null;
  const target = new URL(requestUrl.pathname, env.DASHBOARD_ORIGIN);
  for (const name of ["code", "error", "state"] as const) {
    const values = requestUrl.searchParams.getAll(name);
    if (values.length > 1) return privateRedirect(new URL("/login?google_error=google_failed", env.DASHBOARD_ORIGIN).toString());
    const value = values[0];
    if (value !== undefined && value.length <= 2048) target.searchParams.set(name, value);
  }
  if (target.searchParams.has("code") && target.searchParams.has("error")) return privateRedirect(new URL("/login?google_error=google_failed", env.DASHBOARD_ORIGIN).toString());
  return privateRedirect(target.toString());
}

export const GET: APIRoute = async ({ request, url }) => {
  const env = getBindings();
  const bridge = localBridge(url, env);
  if (bridge !== null) return bridge;
  const headers = new Headers();
  appendClearedStateCookie(headers, env);
  let consumedFlow: "link" | "login" | "register" | null = null;
  try {
    if (url.origin !== env.DASHBOARD_ORIGIN) throw new AppError("google_oauth_invalid", 400, ["callback_origin_invalid"]);
    for (const key of ["state", "code", "error"] as const) {
      if (url.searchParams.getAll(key).length > 1) throw new AppError("google_oauth_invalid", 400, [`${key}_duplicate`]);
    }
    if (url.searchParams.has("code") && url.searchParams.has("error")) throw new AppError("google_oauth_invalid", 400, ["code_error_conflict"]);
    const state = url.searchParams.get("state") ?? "";
    const browserBinding = parseCookies(request.headers.get("Cookie")).get(googleStateCookieName(env)) ?? "";
    const providerError = url.searchParams.get("error");
    if (providerError !== null) {
      const revoked = await revokeGoogleOAuthState({ ...env, browserBinding, receivedState: state });
      consumedFlow = revoked.flow;
      return privateRedirect(errorRedirect(env, googleAuthorizationError(providerError), revoked.flow), headers);
    }
    if (url.searchParams.get("code") === null) throw new AppError("google_oauth_invalid", 400, ["authorization_code_missing"]);
    const consumed = await consumeGoogleOAuthState({ ...env, browserBinding, receivedState: state });
    consumedFlow = consumed.flow;
    if (consumed.redirectUri !== env.GOOGLE_OAUTH_REDIRECT_URI) throw new AppError("google_oauth_state_invalid", 500);
    const code = url.searchParams.get("code") ?? "";
    const claims = await exchangeAndVerifyGoogleCode({ ...env, code, nonce: consumed.nonce, verifier: consumed.verifier });
    if (consumed.flow === "link") {
      const auth = await authenticateRequest(request, env);
      requireRecentAuth(auth);
      if (auth.userId !== consumed.initiatedUserId) throw new AppError("authentication_required", 401);
      await resolveGoogleIdentity({ ...env, claims, initiatedUserId: auth.userId });
      const target = new URL(safeRelativeRedirect(consumed.returnTo, "/app/security?tab=sessions"), env.DASHBOARD_ORIGIN);
      target.searchParams.set("google", "linked");
      return privateRedirect(target.toString(), headers);
    }
    const identity = await resolveGoogleIdentity({ ...env, allowCreate: consumed.flow === "register", claims });
    const user = await env.PLATFORM_DB.prepare(`SELECT status, COALESCE(two_factor_enabled, 0) AS twoFactorEnabled FROM platform_users WHERE id = ? LIMIT 1`).bind(identity.userId).first<{ status: string; twoFactorEnabled: number }>();
    if (user === null || user.status !== "active") throw new AppError("authentication_required", 401);
    const requesterAddress = cloudflareRequesterAddress(request);
    if (user.twoFactorEnabled === 1) {
      const challenge = await issueTwoFactorChallengeForUser({ env, userId: identity.userId });
      await recordLoginHistory({ env, outcome: "two_factor_required", requesterAddress, userId: identity.userId });
      headers.append("Set-Cookie", serializeCookie(googleTwoFactorCookieName(env), challenge.challengeToken, {
        httpOnly: true,
        maxAge: 10 * 60,
        sameSite: "Lax",
        secure: env.APP_ENV !== "local",
      }));
      const target = new URL("/login", env.DASHBOARD_ORIGIN);
      target.searchParams.set("auth", "two_factor");
      target.searchParams.set("redirect", safeRelativeRedirect(consumed.returnTo));
      return privateRedirect(target.toString(), headers);
    }
    const session = await issueSessionForUserId({ env, userId: identity.userId });
    await env.PLATFORM_DB.prepare(`UPDATE platform_users SET last_login_at = ?, updated_at = ? WHERE id = ?`).bind(new Date().toISOString(), new Date().toISOString(), identity.userId).run();
    await recordLoginHistory({ env, outcome: "success", requesterAddress, userId: identity.userId });
    appendSessionCookies(headers, session.credentials, env);
    return privateRedirect(new URL(safeRelativeRedirect(consumed.returnTo), env.DASHBOARD_ORIGIN).toString(), headers);
  } catch (error) {
    return privateRedirect(errorRedirect(env, callbackErrorCode(error), consumedFlow), headers);
  }
};
