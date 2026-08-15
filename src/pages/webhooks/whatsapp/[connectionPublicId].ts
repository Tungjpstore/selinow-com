import type { APIRoute } from "astro";

import { AppError } from "../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import {
  assertWhatsAppIngressAdmitted,
  processWhatsAppWebhook,
  verifyWhatsAppChallengeRequest,
} from "../../../lib/channels/whatsapp-webhooks";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    assertWhatsAppIngressAdmitted();
    const connectionPublicId = params.connectionPublicId;
    if (connectionPublicId === undefined) throw new AppError("webhook_not_found", 404);
    const challenge = await verifyWhatsAppChallengeRequest({ env: getBindings(), connectionPublicId, request });
    return new Response(challenge, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    assertWhatsAppIngressAdmitted();
    const connectionPublicId = params.connectionPublicId;
    if (connectionPublicId === undefined) throw new AppError("webhook_not_found", 404);
    const result = await processWhatsAppWebhook({ env: getBindings(), connectionPublicId, request });
    return Response.json({ ok: true, result, requestId: locals.requestId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
