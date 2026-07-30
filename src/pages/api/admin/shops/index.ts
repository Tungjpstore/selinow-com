import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import {
  listAdminShopDirectory,
  parseAdminShopStatus,
  parseAdminSubscriptionState,
} from "../../../../lib/operations/admin-shop-directory";
import { getBindings } from "../../../../lib/platform/bindings";

function parseLimit(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  if (!/^\d{1,2}$/u.test(value)) throw new AppError("validation_failed", 400, ["limit_invalid"]);
  return Number(value);
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const result = await listAdminShopDirectory({
      env,
      filters: {
        cursor: url.searchParams.get("cursor"),
        ...(limit === undefined ? {} : { limit }),
        query: url.searchParams.get("q"),
        shopStatus: parseAdminShopStatus(url.searchParams.get("status")),
        subscriptionState: parseAdminSubscriptionState(url.searchParams.get("subscription")),
      },
      userId: auth.userId,
    });
    return Response.json({ nextCursor: result.nextCursor, ok: true, requestId: locals.requestId, shops: result.shops }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
