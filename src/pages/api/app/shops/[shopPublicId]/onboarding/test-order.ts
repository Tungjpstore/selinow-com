import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { runControlledTestOrder } from "../../../../../../lib/onboarding/test-order";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { runShopReadiness } from "../../../../../../lib/tenants/readiness";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["quantity", "variantId"]);
    const result = await runControlledTestOrder({
      body,
      env,
      requestId: locals.requestId,
      runReadiness: runShopReadiness,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });

    return Response.json({ ok: true, requestId: locals.requestId, testOrder: result }, {
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
