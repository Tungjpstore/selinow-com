import type { APIRoute } from "astro";

import { magicLinkRequesterAddress } from "../../../../lib/auth/admission";
import { assertDashboardOrigin, normalizeDisplayName, normalizeEmail } from "../../../../lib/auth/policy";
import { appendMagicLinkInitiationCookie, requestMagicLink } from "../../../../lib/auth/session";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    assertDashboardOrigin(request, env.DASHBOARD_ORIGIN);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["displayName", "email"]);
    const email = normalizeEmail(body.email);
    const displayName = normalizeDisplayName(body.displayName, email);
    const { initiationBinding, ...result } = await requestMagicLink({
      displayName,
      email,
      env,
      locale: locals.locale,
      requesterAddress: magicLinkRequesterAddress(request),
    });

    const response = Response.json(
      { ok: true, accepted: true, ...result, requestId: locals.requestId },
      {
        status: 202,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
    appendMagicLinkInitiationCookie(response.headers, initiationBinding, env);
    return response;
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
