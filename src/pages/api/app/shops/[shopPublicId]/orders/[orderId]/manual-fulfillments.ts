import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import {
  completeManualFulfillment,
  parseManualFulfillmentExecutionInput,
} from "../../../../../../../lib/commerce/manual-fulfillment";
import { readJsonObject } from "../../../../../../../lib/http/request";
import {
  createPrivateCaughtErrorResponse,
  PRIVATE_RESPONSE_HEADERS,
} from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const result = await completeManualFulfillment({
      env,
      execution: parseManualFulfillmentExecutionInput(await readJsonObject(request, 4 * 1_024)),
      idempotencyKey: request.headers.get("Idempotency-Key"),
      orderPublicId: requireResourceId(params.orderId, "order"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
      status: result.replayed ? 200 : 201,
    });
  } catch (error) {
    return createPrivateCaughtErrorResponse(error, locals.requestId);
  }
};
