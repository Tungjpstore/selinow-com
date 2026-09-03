import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { setSellerDiscountStatus } from "../../../../../../lib/commerce/seller-discounts";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

/** EX3.4b — enable/disable a discount (forward-only lifecycle; no edits, no deletes). */
export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["status"]);
    if (body.status !== "active" && body.status !== "disabled") {
      return Response.json({ code: "validation_failed", details: ["discount_status_invalid"], ok: false }, { headers: PRIVATE_HEADERS, status: 400 });
    }
    const discount = await setSellerDiscountStatus({
      discountPublicId: requireResourceId(params.discountId, "discount"),
      env,
      nextStatus: body.status,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ discount, ok: true, requestId: locals.requestId }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
