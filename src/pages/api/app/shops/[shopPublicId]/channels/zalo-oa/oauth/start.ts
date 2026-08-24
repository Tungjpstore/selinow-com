import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../../lib/auth/session";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../../lib/platform/bindings";
import { requireResourceId } from "../../../../../../../../lib/catalog/policy";
import { startZaloOfficialAccountOAuth } from "../../../../../../../../lib/channels/zalo-oa-oauth-routes";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["appId", "connectorRequestPublicId", "redirectUri"]);
    const oauth = await startZaloOfficialAccountOAuth({
      appId: body.appId,
      connectorRequestPublicId: body.connectorRequestPublicId,
      env,
      redirectUri: body.redirectUri,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ok: true, oauth, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
      status: 201,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
