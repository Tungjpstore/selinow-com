import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { listSellerBillingPlans } from "../../../../../../lib/tenants/billing-requests";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const plans = await listSellerBillingPlans({ env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ ok: true, plans, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
