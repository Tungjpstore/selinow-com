import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { transitionBooking } from "../../../../../../lib/commerce/booking";
import { readJsonObject } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request);
    const booking = await transitionBooking({
      bookingId: requireResourceId(params.bookingId, "bkg"),
      env,
      nextStatus: body.nextStatus,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ booking, ok: true, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
