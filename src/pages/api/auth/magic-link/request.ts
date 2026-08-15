import type { APIRoute } from "astro";

import { magicLinkRequesterAddress, verifyMagicLinkChallenge } from "../../../../lib/auth/admission";
import { assertDashboardOrigin, normalizeDisplayName, normalizeEmail } from "../../../../lib/auth/policy";
import { appendMagicLinkInitiationCookie, requestMagicLink } from "../../../../lib/auth/session";
import { isAppError } from "../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { loggerFor } from "../../../../lib/operations/logger";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  const env = getBindings();
  try {
    assertDashboardOrigin(request, env.DASHBOARD_ORIGIN);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["displayName", "email", "turnstileToken"]);
    const email = normalizeEmail(body.email);
    const displayName = normalizeDisplayName(body.displayName, email);
    const challengePassed = body.turnstileToken !== undefined;
    if (challengePassed) {
      await verifyMagicLinkChallenge({ env, request, token: body.turnstileToken });
    }
    const result = await requestMagicLink({
      challengePassed,
      displayName,
      email,
      env,
      locale: locals.locale,
      requesterAddress: magicLinkRequesterAddress(request),
    });
    const { initiationBinding, ...publicResult } = result;

    const response = Response.json(
      { ok: true, accepted: true, ...publicResult, requestId: locals.requestId },
      {
        status: 202,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
    if (!result.challengeRequired) appendMagicLinkInitiationCookie(response.headers, initiationBinding, env);
    return response;
  } catch (error) {
    const failure = isAppError(error)
      ? { errorCode: error.code, status: error.status }
      : { errorCode: "internal_error", status: 500 };
    if (failure.status >= 403) {
      loggerFor(env).warn({
        ...failure,
        event: "auth.magic_link_request_failed",
        requestId: locals.requestId,
        source: "http",
      });
    }
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
