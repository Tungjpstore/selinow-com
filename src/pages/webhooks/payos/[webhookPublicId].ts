import type { APIRoute } from "astro";

import { AppError } from "../../../lib/core/errors";
import { readJsonObject } from "../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { processPayOSWebhook } from "../../../lib/payments/webhooks";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const webhookPublicId = params.webhookPublicId;
    if (webhookPublicId === undefined || !/^paywh_[0-9a-f-]{36}$/u.test(webhookPublicId)) throw new AppError("webhook_not_found", 404);
    const result = await processPayOSWebhook({ body: await readJsonObject(request, 64 * 1024), env: getBindings(), webhookPublicId });
    return Response.json({ data: result, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
