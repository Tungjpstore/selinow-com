import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../lib/catalog/policy";
import { createBookingResource, upsertBookingSchedule } from "../../../../../lib/commerce/booking";
import { readJsonObject } from "../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

/** POST {name, roleLabel} creates a resource; POST {resourceId, weekday, startMinute, endMinute} sets a window. */
export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    const input = {
      data: body,
      env,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    };
    const result = typeof body.resourceId === "string"
      ? await upsertBookingSchedule({ ...input, resourceId: body.resourceId })
      : await createBookingResource(input);
    return Response.json({ ok: true, requestId: locals.requestId, result }, { status: 201, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
