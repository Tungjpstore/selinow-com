import type { APIRoute } from "astro";

import { AppError } from "../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { processTelegramWebhook } from "../../../lib/telegram/webhooks";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const webhookPublicId = params.webhookPublicId;
    if (webhookPublicId === undefined || !/^tgwh_[0-9a-f-]{36}$/u.test(webhookPublicId)) throw new AppError("webhook_not_found", 404);
    const result = await processTelegramWebhook({ env: getBindings(), request, requestId: locals.requestId, webhookPublicId });
    return Response.json({ data: result, ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
