import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createCustomDomain, listShopDomains } from "../../../../../../lib/domains/store";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const domains = await listShopDomains({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ domains, ok: true, requestId: locals.requestId }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["hostname"]);
    const result = await createCustomDomain({
      env,
      hostname: body.hostname,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ domain: result.domain, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_HEADERS,
      status: result.created ? 201 : 200,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
