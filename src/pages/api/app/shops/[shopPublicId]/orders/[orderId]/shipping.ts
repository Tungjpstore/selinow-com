import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { advanceOrderShipping } from "../../../../../../../lib/commerce/shipping";
import { readJsonObject } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request);
    const result = await advanceOrderShipping({
      ...(body.carrier === undefined ? {} : { carrier: body.carrier }),
      env,
      orderId: requireResourceId(params.orderId, "order"),
      requestId: locals.requestId,
      shippingState: body.shippingState,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      ...(body.trackingCode === undefined ? {} : { trackingCode: body.trackingCode }),
      userId: auth.userId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, shipping: result }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
