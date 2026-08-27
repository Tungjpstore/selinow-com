import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../lib/auth/session";
import { AppError } from "../../../../../lib/core/errors";
import { hmacToken } from "../../../../../lib/core/crypto";
import { guardAdminMutationRate } from "../../../../../lib/http/admin-rate-limit";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";
import { requirePlatformAdminApiAccess } from "../../../../../lib/tenants/store";

const CLIENT_ID = /^[A-Za-z0-9._:-]{3,128}$/u;

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    if (env.APP_ENV !== "staging") throw new AppError("payment_provider_environment_not_admitted", 409);
    const auth = await requireCsrfSession(request, env);
    await guardAdminMutationRate({ env, family: "payments_payos", request });
    await requirePlatformAdminApiAccess({ env, userId: auth.userId });
    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["clientId"]);
    if (typeof body.clientId !== "string" || !CLIENT_ID.test(body.clientId.trim())) throw new AppError("validation_failed", 400, ["client_id_invalid"]);
    const fingerprint = await hmacToken(env.IDENTIFIER_HMAC_SECRET, "payos-provider-identity:v1", body.clientId.trim());
    return Response.json({ environment: "staging", fingerprint, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
