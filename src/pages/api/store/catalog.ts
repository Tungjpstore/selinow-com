import type { APIRoute } from "astro";

import { createCaughtErrorResponse } from "../../../lib/http/security";
import { getBindings } from "../../../lib/platform/bindings";
import { getStorefrontCatalog, resolveStorefrontShop } from "../../../lib/storefront/store";

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    const catalog = await getStorefrontCatalog(env, shop);
    return Response.json({
      ...catalog,
      ok: true,
      requestId: locals.requestId,
      shop: {
        currency: shop.currency,
        name: shop.name,
        publicDetails: shop.publicDetails,
        slug: shop.slug,
      },
    }, { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60", "Vary": "Accept-Language, Host" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
