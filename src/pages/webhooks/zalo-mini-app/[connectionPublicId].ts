import type { APIRoute } from "astro";

import { AppError } from "../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { processZaloMiniAppWebhook } from "../../../lib/channels/zalo-mini-app-webhooks";

/**
 * Zalo Mini App Open API webhook. The service performs tenant resolution,
 * provider proof, canonical parsing and durable reference claim in that order.
 * No payload is returned and no commerce state is changed at this boundary.
 */
export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const connectionPublicId = params.connectionPublicId;
    if (connectionPublicId === undefined) {
      throw new AppError("webhook_not_found", 404);
    }
    const result = await processZaloMiniAppWebhook({
      connectionPublicId,
      env: getBindings(),
      request,
    });
    return Response.json({ data: result, ok: true }, {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
