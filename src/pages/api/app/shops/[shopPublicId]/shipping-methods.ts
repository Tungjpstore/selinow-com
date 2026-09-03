import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession } from "../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../lib/catalog/policy";
import { createShippingMethod, listSellerShippingMethods } from "../../../../../lib/commerce/shipping";
import { readJsonObject } from "../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const methods = await listSellerShippingMethods({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ methods, ok: true, requestId: locals.requestId }, { headers: PRIVATE_HEADERS });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const method = await createShippingMethod({
      data: await readJsonObject(request),
      env,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ method, ok: true, requestId: locals.requestId }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
