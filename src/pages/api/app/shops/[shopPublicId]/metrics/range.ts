import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { getSellerMetricsRange, parseMetricsDays } from "../../../../../../lib/dashboard/metrics";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

/** EX3.1 — real revenue series for the cockpit sparkline (7/30 days). */
export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const url = new URL(request.url);
    const days = parseMetricsDays(url.searchParams.get("days"));
    const metrics = await getSellerMetricsRange({
      days,
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ days, metrics, ok: true, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
