import type { APIRoute } from "astro";

import {
  appendClearedMagicLinkConfirmationCookie,
  appendClearedMagicLinkInitiationCookie,
  appendMagicLinkConfirmationCookie,
  appendSessionCookies,
  authenticateRequest,
  consumeMagicLinkFromBrowser,
  magicLinkConfirmationCookieName,
  magicLinkInitiationCookieName,
} from "../../../../lib/auth/session";
import { assertDashboardOrigin } from "../../../../lib/auth/policy";
import { AppError, isAppError } from "../../../../lib/core/errors";
import { parseCookies } from "../../../../lib/http/cookies";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

function privateJson(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const GET: APIRoute = ({ redirect, request }) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (token.length < 20 || token.length > 256) return redirect("/login", 303);
  const fragment = new URLSearchParams({ magic: token }).toString();
  const response = redirect(`/login#${fragment}`, 303);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    assertDashboardOrigin(request, env.DASHBOARD_ORIGIN);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["confirm", "token"]);
    if (typeof body.token !== "string") throw new AppError("authentication_required", 401);
    if (body.confirm !== undefined && typeof body.confirm !== "boolean") {
      throw new AppError("validation_failed", 400, ["confirm_invalid"]);
    }

    let existingSession = false;
    try {
      await authenticateRequest(request, env);
      existingSession = true;
    } catch (error) {
      if (!isAppError(error) || error.code !== "authentication_required") throw error;
    }

    const cookies = parseCookies(request.headers.get("Cookie"));
    const result = await consumeMagicLinkFromBrowser({
      confirmationBinding: cookies.get(magicLinkConfirmationCookieName(env)) ?? "",
      confirm: body.confirm === true,
      env,
      existingSession,
      initiationBinding: cookies.get(magicLinkInitiationCookieName(env)) ?? "",
      token: body.token,
    });

    if (result.confirmationRequired) {
      const response = privateJson({
        confirmationRequired: true,
        maskedDestination: result.maskedDestination,
        ok: true,
        requestId: locals.requestId,
      }, 202);
      appendMagicLinkConfirmationCookie(response.headers, result.confirmationBinding, env);
      return response;
    }

    const response = privateJson({
      authenticated: true,
      ok: true,
      redirectTo: "/app",
      requestId: locals.requestId,
    }, 200);
    appendSessionCookies(response.headers, result.credentials, env);
    appendClearedMagicLinkInitiationCookie(response.headers, env);
    appendClearedMagicLinkConfirmationCookie(response.headers, env);
    return response;
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
