import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../../lib/platform/bindings";
import { redactOrderMessage } from "../../../../../../../../lib/commerce/order-messages";

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["expectedVersion"]);
    const message = await redactOrderMessage({
      env,
      expectedVersion: body.expectedVersion as number,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      messagePublicId: requireResourceId(params.messagePublicId, "omsg"),
      orderPublicId: requireResourceId(params.orderId, "order"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ message, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
