import type { APIRoute } from "astro";

import {
  parseApiCredentialRevokeInput,
  revokeApiCredential,
} from "../../../../../../lib/api/credentials";
import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import {
  createPrivateCaughtErrorResponse,
  PRIVATE_RESPONSE_HEADERS,
} from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1_024);
    rejectUnknownFields(body, ["expectedVersion", "reasonCode"]);
    const credential = await revokeApiCredential({
      ...parseApiCredentialRevokeInput(body),
      credentialPublicId: requireResourceId(params.credentialPublicId, "akc"),
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ credential, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
    });
  } catch (error) {
    return createPrivateCaughtErrorResponse(error, locals.requestId);
  }
};
