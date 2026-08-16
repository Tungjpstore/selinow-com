import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { listSellerBookings } from "../../../../../../lib/commerce/booking";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request, url }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const bookings = await listSellerBookings({
      env,
      rangeEndIso: url.searchParams.get("rangeEnd") ?? "",
      rangeStartIso: url.searchParams.get("rangeStart") ?? "",
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ bookings, ok: true, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
