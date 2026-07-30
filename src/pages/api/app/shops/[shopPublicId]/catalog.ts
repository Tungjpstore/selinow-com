import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";
import { listSellerCatalog } from "../../../../../lib/catalog/store";
import { requireResourceId } from "../../../../../lib/catalog/policy";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const catalog = await listSellerCatalog({ env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ ok: true, requestId: locals.requestId, ...catalog }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
