import type { APIRoute } from "astro";

import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { processDiscordWebhook } from "../../../lib/channels/discord-webhooks";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const connectionPublicId = params.connectionPublicId;
    const result = await processDiscordWebhook({
      connectionPublicId: connectionPublicId ?? "",
      env: getBindings(),
      request,
    });
    // Autocomplete interactions require the provider's distinct type-8
    // callback; a deferred message callback is invalid for type 4.
    const body = result.result === "ping"
      ? { type: 1 }
      : result.interactionType === 4
        ? { type: 8, data: { choices: [] } }
        : { type: 5 };
    return Response.json(body, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
