import type { APIRoute } from "astro";

import { backfillActivationMilestones } from "../../../../../lib/analytics/activation";
import { processDodoWebhookRequest } from "../../../../../lib/billing/service";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

/** Canonical Dodo Payments webhook path. */
export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const result = await processDodoWebhookRequest({
      env,
      request,
      webhookPublicId: params.webhookPublicId ?? "",
    });
    // Billing state is authoritative; this recovery pass only backfills the
    // derived trial-conversion milestone and never changes billing state.
    try {
      const shops = await env.PLATFORM_DB.prepare(`
        SELECT DISTINCT shop_id AS shopId
        FROM subscription_events
        WHERE from_state = 'trialing' AND to_state = 'active'
      `).all<{ shopId: string }>();
      await Promise.all(shops.results.map((shop) => backfillActivationMilestones({ env, shopId: shop.shopId })));
    } catch {
      // Analytics recovery is non-critical to the signed billing response.
    }
    return Response.json({ data: result, ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
