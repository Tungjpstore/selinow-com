import type { APIRoute } from "astro";

import { backfillActivationMilestones } from "../../../../../lib/analytics/activation";
import { processDodoWebhookRequest } from "../../../../../lib/billing/service";
import { AppError } from "../../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

const WEBHOOK_PUBLIC_ID_PATTERN = /^(?:ddowh|dodow)_[0-9a-f-]{36}$/u;

type DodoWebhookRouteBindings = AppBindingsLike & {
  DODO_PAYMENTS_WEBHOOK_PUBLIC_ID?: unknown;
};

type AppBindingsLike = ReturnType<typeof getBindings>;

function assertConfiguredWebhookPublicId(env: DodoWebhookRouteBindings, webhookPublicId: string): void {
  const configured: unknown = env.DODO_PAYMENTS_WEBHOOK_PUBLIC_ID;
  if (configured === undefined) return;
  if (typeof configured !== "string" || !WEBHOOK_PUBLIC_ID_PATTERN.test(configured)) {
    throw new AppError("billing_provider_invalid", 502, ["webhook_public_id"]);
  }
  if (configured !== webhookPublicId) throw new AppError("webhook_not_found", 404);
}

async function backfillProcessedWebhookShop(input: {
  env: DodoWebhookRouteBindings;
  request: Request;
  result: { processed: boolean; state: string };
}): Promise<void> {
  if (!input.result.processed || input.result.state !== "active") return;
  const webhookId = input.request.headers.get("webhook-id");
  if (webhookId === null || !/^[A-Za-z0-9._:-]{3,160}$/u.test(webhookId)) return;
  try {
    const row = await input.env.PLATFORM_DB.prepare(`
      SELECT shop_id AS shopId
      FROM billing_provider_events
      WHERE provider_code = 'dodo' AND provider_event_id = ?
        AND status = 'processed' AND shop_id IS NOT NULL
      LIMIT 1
    `).bind(webhookId).first<{ shopId: string }>();
    if (row?.shopId === undefined) return;
    await backfillActivationMilestones({ env: input.env, shopId: row.shopId });
  } catch {
    // Analytics recovery is best effort and must not affect billing response.
  }
}

/** Canonical Dodo Payments webhook path. */
export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const webhookPublicId = params.webhookPublicId ?? "";
    if (!WEBHOOK_PUBLIC_ID_PATTERN.test(webhookPublicId)) throw new AppError("webhook_not_found", 404);
    assertConfiguredWebhookPublicId(env, webhookPublicId);
    const result = await processDodoWebhookRequest({
      env,
      request,
      webhookPublicId,
    });
    // Billing state is authoritative; this bounded pass only backfills the
    // affected shop's derived trial-conversion milestone.
    await backfillProcessedWebhookShop({ env, request, result });
    return Response.json({ data: result, ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
