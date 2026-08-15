import type { APIRoute } from "astro";

import { getPublicApiCatalog } from "../../../lib/api/catalog";
import { authenticatePublicApiRequest, recordPublicApiUsage } from "../../../lib/api/credentials";
import { isAppError } from "../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
};

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const context = await authenticatePublicApiRequest({
      env,
      request,
      requiredScope: "catalog:read",
    });
    const catalog = await getPublicApiCatalog({
      currency: context.shop.currency,
      env,
      shopId: context.shopId,
    });
    await recordPublicApiUsage({ context, env, requestId: locals.requestId });
    return Response.json({
      data: { catalog, shop: context.shop },
      ok: true,
      requestId: locals.requestId,
    }, {
      headers: {
        ...PRIVATE_HEADERS,
        "X-RateLimit-Limit": String(context.rateLimit.limit),
        "X-RateLimit-Remaining": String(context.rateLimit.remaining),
        "X-RateLimit-Reset": context.rateLimit.resetAt,
      },
    });
  } catch (error) {
    const response = createCaughtErrorResponse(error, locals.requestId);
    if (isAppError(error) && error.code === "rate_limited") {
      response.headers.set("Retry-After", "60");
      response.headers.set("X-RateLimit-Limit", "60");
      response.headers.set("X-RateLimit-Remaining", "0");
    }
    return response;
  }
};
