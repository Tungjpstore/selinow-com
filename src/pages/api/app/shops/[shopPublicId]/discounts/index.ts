import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createSellerDiscount, listSellerDiscounts } from "../../../../../../lib/commerce/seller-discounts";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

/** EX3.4b — seller discount management (list + create). */
export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const result = await listSellerDiscounts({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ discounts: result.discounts, ok: true, requestId: locals.requestId }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["code", "endsAt", "minimumMinor", "startsAt", "type", "value"]);
    const discount = await createSellerDiscount({
      body,
      env,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ discount, ok: true, requestId: locals.requestId }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
