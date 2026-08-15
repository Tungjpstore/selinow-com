import type { APIRoute } from "astro";

import { authenticatePublicApiRequest, recordPublicApiUsage } from "../../../lib/api/credentials";
import { getPublicApiOrders } from "../../../lib/api/orders";
import { parsePublicApiPage } from "../../../lib/api/pagination";
import { isAppError } from "../../../lib/core/errors";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const context = await authenticatePublicApiRequest({ env, request, requiredScope: "orders:read" });
    const orders = await getPublicApiOrders({ env, page: parsePublicApiPage(new URL(request.url)), shopId: context.shopId });
    await recordPublicApiUsage({ context, env, requestId: locals.requestId });
    return Response.json({ data: { orders, shop: context.shop }, ok: true, requestId: locals.requestId }, {
      headers: {
        ...PRIVATE_RESPONSE_HEADERS,
        "X-RateLimit-Limit": String(context.rateLimit.limit),
        "X-RateLimit-Remaining": String(context.rateLimit.remaining),
        "X-RateLimit-Reset": context.rateLimit.resetAt,
      },
    });
  } catch (error) {
    const response = createCaughtErrorResponse(error, locals.requestId);
    for (const [name, value] of Object.entries(PRIVATE_RESPONSE_HEADERS)) response.headers.set(name, value);
    if (isAppError(error) && error.code === "rate_limited") {
      response.headers.set("Retry-After", "60");
      response.headers.set("X-RateLimit-Limit", "60");
      response.headers.set("X-RateLimit-Remaining", "0");
    }
    return response;
  }
};
