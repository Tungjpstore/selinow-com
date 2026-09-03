import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { requestTwoFactorDisableOtp } from "../../../../lib/auth/two-factor";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const result = await requestTwoFactorDisableOtp({ auth, env, locale: locals.locale });
    return Response.json({
      ok: true,
      requestId: locals.requestId,
      cooldownSeconds: result.cooldownSeconds,
      expiresAt: result.expiresAt,
      ...(result.debugOtp === undefined ? {} : { debugOtp: result.debugOtp }),
    }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
