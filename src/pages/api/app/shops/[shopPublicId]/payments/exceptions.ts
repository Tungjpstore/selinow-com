import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { listPaymentExceptions } from "../../../../../../lib/payments/reconciliation";
import { getShopForMember } from "../../../../../../lib/tenants/store";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const member = await getShopForMember({ capability: "payments:manage", env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    const exceptions = await listPaymentExceptions({ env, shopId: member.row.shop_id });
    return Response.json({ exceptions, ok: true, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
