import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth, authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { readJsonObject } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { connectPayOS, disconnectPayOS, getPaymentIntegration } from "../../../../../../lib/payments/integrations";
import { parsePayOSCredentials } from "../../../../../../lib/payments/policy";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const integration = await getPaymentIntegration({ env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ integration, ok: true, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const integration = await connectPayOS({ credentials: parsePayOSCredentials(await readJsonObject(request)), env, requestId: locals.requestId, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ integration, ok: true, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    await disconnectPayOS({ env, requestId: locals.requestId, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return new Response(null, { status: 204 });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
