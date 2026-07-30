import type { APIRoute } from "astro";

import {
  issueApiCredential,
  listApiCredentials,
  parseApiCredentialCreateInput,
} from "../../../../../../lib/api/credentials";
import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import {
  createPrivateCaughtErrorResponse,
  PRIVATE_RESPONSE_HEADERS,
} from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    requireRecentAuth(auth);
    const credentials = await listApiCredentials({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ credentials, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
    });
  } catch (error) {
    return createPrivateCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1_024);
    rejectUnknownFields(body, ["expiresAt", "name", "scopes"]);
    const result = await issueApiCredential({
      ...parseApiCredentialCreateInput(body),
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
      status: result.replayed ? 200 : 201,
    });
  } catch (error) {
    return createPrivateCaughtErrorResponse(error, locals.requestId);
  }
};
