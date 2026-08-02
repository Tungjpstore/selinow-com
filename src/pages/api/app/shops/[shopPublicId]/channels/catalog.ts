import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { listAvailableChannelExpansions } from "../../../../../../lib/channels/connector-requests";
import { getShopForMember } from "../../../../../../lib/tenants/store";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    await getShopForMember({ capability: "shop:read", env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ expansions: listAvailableChannelExpansions(), ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
