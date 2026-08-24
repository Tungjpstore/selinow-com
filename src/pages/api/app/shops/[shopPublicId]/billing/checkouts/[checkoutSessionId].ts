import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../../../lib/auth/session";
import { getSellerBillingCheckoutStatus } from "../../../../../../../lib/billing/service";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    const checkoutSessionId = requireResourceId(params.checkoutSessionId, "bchk");
    const checkout = await getSellerBillingCheckoutStatus({
      checkoutSessionId,
      env,
      fetcher: fetch,
      shopPublicId,
      userId: auth.userId,
    });
    return Response.json({ checkout, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
