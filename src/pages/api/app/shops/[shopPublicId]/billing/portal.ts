import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { createTenantBillingPortalSession } from "../../../../../../lib/billing/service";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

/** Creates a short-lived Dodo portal session without exposing provider credentials. */
export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    const returnUrl = new URL("/app/billing", request.url);
    returnUrl.searchParams.set("shop", shopPublicId);
    const portal = await createTenantBillingPortalSession({
      env,
      fetcher: fetch,
      returnUrl: returnUrl.toString(),
      shopPublicId,
      userId: auth.userId,
    });
    return Response.json({ ok: true, portal, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
