import type { APIRoute } from "astro";

import {
  appendClearedMagicLinkInitiationCookie,
  appendSessionCookies,
  consumeMagicLink,
  magicLinkInitiationCookieName,
} from "../../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { parseCookies } from "../../../../lib/http/cookies";
import { getBindings } from "../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, redirect, request }) => {
  try {
    const url = new URL(request.url);
    const env = getBindings();
    const initiationBinding = parseCookies(request.headers.get("Cookie"))
      .get(magicLinkInitiationCookieName(env)) ?? "";
    const result = await consumeMagicLink({
      env,
      initiationBinding,
      token: url.searchParams.get("token") ?? "",
    });
    const response = redirect("/app", 303);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("Referrer-Policy", "no-referrer");
    appendSessionCookies(response.headers, result.credentials, env);
    appendClearedMagicLinkInitiationCookie(response.headers, env);
    return response;
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
