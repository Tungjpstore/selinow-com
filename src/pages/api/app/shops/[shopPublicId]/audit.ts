import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../lib/catalog/policy";
import { AppError } from "../../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";
import { listSellerAuditEntries } from "../../../../../lib/operations/seller-audit";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (key !== "limit" || url.searchParams.getAll(key).length !== 1) {
        throw new AppError("validation_failed", 400, [`query_${key}_invalid`]);
      }
    }
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    const entries = await listSellerAuditEntries({
      env,
      ...(limit === undefined ? {} : { limit }),
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ entries, ok: true, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
