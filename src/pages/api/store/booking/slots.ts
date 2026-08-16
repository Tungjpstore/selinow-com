import type { APIRoute } from "astro";

import { listBookingSlots } from "../../../../lib/commerce/booking";
import { AppError } from "../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { assertStorefrontLive, resolveStorefrontShop } from "../../../../lib/storefront/store";

export const GET: APIRoute = async ({ locals, request, url }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    assertStorefrontLive(shop);
    const variantId = url.searchParams.get("variantId") ?? "";
    if (!/^var_[0-9a-f-]{36}$/u.test(variantId)) throw new AppError("validation_failed", 400, ["variant_id_invalid"]);
    const dateStart = url.searchParams.get("dateStart") ?? "";
    const dateEnd = url.searchParams.get("dateEnd") ?? "";
    const slots = await listBookingSlots({ dateStart, dateEnd, env, shop: { id: shop.id, timezone: shop.timezone }, variantId });
    return Response.json({ ok: true, requestId: locals.requestId, slots }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
