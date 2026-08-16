import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { updateShippingMethod } from "../../../../../../lib/commerce/shipping";
import { readJsonObject } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const method = await updateShippingMethod({
      data: await readJsonObject(request),
      env,
      methodId: requireResourceId(params.methodId, "shm"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ method, ok: true, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
