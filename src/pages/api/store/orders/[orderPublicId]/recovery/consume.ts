import type { APIRoute } from "astro";

import { consumeBuyerOrderRecovery } from "../../../../../../lib/commerce/buyer-order-recovery";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { resolveStorefrontShop } from "../../../../../../lib/storefront/store";

function assertSameOrigin(request: Request): void {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (origin !== expected || fetchSite === "cross-site") {
    throw new AppError("order_recovery_origin_invalid", 403);
  }
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    assertSameOrigin(request);
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["token"]);
    const order = await consumeBuyerOrderRecovery({
      env,
      orderPublicId: params.orderPublicId ?? "",
      requestId: locals.requestId,
      shop,
      token: body.token,
    });
    return Response.json(
      { ok: true, order, requestId: locals.requestId },
      { headers: { ...PRIVATE_RESPONSE_HEADERS, "Referrer-Policy": "no-referrer" } },
    );
  } catch (error) {
    const response = createCaughtErrorResponse(error, locals.requestId);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
};
