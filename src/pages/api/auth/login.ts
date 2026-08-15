import type { APIRoute } from "astro";

import { isAppError } from "../../../lib/core/errors";
import { normalizeEmail } from "../../../lib/auth/policy";
import { appendSessionCookies, loginWithPassword } from "../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { loggerFor } from "../../../lib/operations/logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["email", "password", "rememberMe"]);

    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const rememberMe = body.rememberMe === true;

    const result = await loginWithPassword({
      email,
      env,
      password,
      rememberMe,
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
      event: "auth.password_login_failed",
      requestId: locals.requestId,
      source: "http",
    });

    return createCaughtErrorResponse(error, locals.requestId);
  }
};
