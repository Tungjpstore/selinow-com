import type { APIRoute } from "astro";

import { AppError } from "../../../../lib/core/errors";
import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { disableTwoFactor } from "../../../../lib/auth/two-factor";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);

    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["otp", "password"]);
    const otp = typeof body.otp === "string" ? body.otp : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (otp.length > 0 && password.length > 0) {
      throw new AppError("validation_failed", 400, ["reauthentication_ambiguous"]);
    }
    if (otp.length > 16 || password.length > 128) {
      throw new AppError("validation_failed", 400, ["reauthentication_invalid"]);
    }

    await disableTwoFactor({
      auth,
      env,
      ...(otp.length === 0 ? {} : { otp }),
      ...(password.length === 0 ? {} : { password }),
    });
    return Response.json({ ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
