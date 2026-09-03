import type { APIRoute } from "astro";

import { claimProvisioningAdmission, cloudflareRequesterAddress } from "../../../../lib/auth/admission";
import { issueGoogleOAuthState, googleStateCookieName } from "../../../../lib/auth/google";
import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { createOpaqueToken } from "../../../../lib/core/ids";
import { serializeCookie } from "../../../../lib/http/cookies";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

const ADMISSION_LIMITS = { global: 500, requester: 20, subject: 20, windowSeconds: 15 * 60 } as const;

function singleSearchParam(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new AppError("validation_failed", 400, [`${name}_duplicate`]);
  return values[0] ?? null;
}

function rejectUnknownSearchParams(url: URL, allowed: readonly string[]): void {
  const allowedNames = new Set(allowed);
  for (const name of url.searchParams.keys()) {
    if (!allowedNames.has(name)) throw new AppError("validation_failed", 400, [`${name}_unexpected`]);
  }
}

function appendStateCookie(headers: Headers, binding: string, env: ReturnType<typeof getBindings>): void {
  headers.append("Set-Cookie", serializeCookie(googleStateCookieName(env), binding, {
    httpOnly: true,
    maxAge: 10 * 60,
    sameSite: "Lax",
    secure: env.APP_ENV !== "local",
  }));
}

async function issue(input: {
  flow: "link" | "login" | "register";
  initiatedUserId?: string;
  request: Request;
  returnTo?: string;
}): Promise<{ authorizationUrl: string; binding: string }> {
  const env = getBindings();
  const binding = createOpaqueToken(32);
  await claimProvisioningAdmission({
    action: "google_oauth_start",
    env,
    limits: ADMISSION_LIMITS,
    now: new Date(),
    requesterAddress: cloudflareRequesterAddress(input.request),
    subject: input.initiatedUserId ?? cloudflareRequesterAddress(input.request),
  });
  const state = await issueGoogleOAuthState({
    ...env,
    browserBinding: binding,
    flow: input.flow,
    ...(input.initiatedUserId === undefined ? {} : { initiatedUserId: input.initiatedUserId }),
    ...(input.returnTo === undefined ? {} : { returnTo: input.returnTo }),
  });
  return { authorizationUrl: state.authorizationUrl, binding };
}

export const GET: APIRoute = async ({ locals, request, url }) => {
  const env = getBindings();
  try {
    if (url.origin !== env.DASHBOARD_ORIGIN) {
      const canonical = new URL(url.pathname, env.DASHBOARD_ORIGIN);
      canonical.search = url.search;
      return Response.redirect(canonical.toString(), 308);
    }
    rejectUnknownSearchParams(url, ["flow", "redirect"]);
    const requestedFlow = singleSearchParam(url, "flow");
    if (requestedFlow !== "login" && requestedFlow !== "register") throw new AppError("validation_failed", 400, ["flow_invalid"]);
    const returnTo = singleSearchParam(url, "redirect");
    const result = await issue({ flow: requestedFlow, request, ...(returnTo === null ? {} : { returnTo }) });
    const headers = new Headers({ "Cache-Control": "private, no-store, max-age=0", Location: result.authorizationUrl, "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
    appendStateCookie(headers, result.binding, env);
    return new Response(null, { headers, status: 303 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const env = getBindings();
  try {
    rejectUnknownSearchParams(url, ["flow"]);
    if (singleSearchParam(url, "flow") !== "link") throw new AppError("validation_failed", 400, ["flow_invalid"]);
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["returnTo"]);
    const returnTo = typeof body.returnTo === "string" ? body.returnTo : undefined;
    const result = await issue({
      flow: "link",
      initiatedUserId: auth.userId,
      request,
      ...(returnTo === undefined ? {} : { returnTo }),
    });
    const response = Response.json({ authorizationUrl: result.authorizationUrl, ok: true, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" },
    });
    appendStateCookie(response.headers, result.binding, env);
    return response;
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
