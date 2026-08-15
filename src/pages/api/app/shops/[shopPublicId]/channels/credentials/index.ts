import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth, authenticateRequest } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import {
  createChannelCredentialEnvelope,
  listChannelCredentialProjections,
  parseChannelCredentialEnvelopeInput,
} from "../../../../../../../lib/channels/credential-routes";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createPrivateCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    requireRecentAuth(auth);
    const credentials = await listChannelCredentialProjections({
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
    const body = await readJsonObject(request, 40 * 1_024);
    rejectUnknownFields(body, ["ciphertextB64", "connectionPublicId", "fingerprint", "ivB64", "keyVersion"]);
    const result = await createChannelCredentialEnvelope({
      env,
      envelope: parseChannelCredentialEnvelopeInput(body),
      idempotencyKey: request.headers.get("Idempotency-Key"),
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
