import type { APIRoute } from "astro";

import { AppError } from "../../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { getStorefrontProduct, resolveStorefrontShop } from "../../../../lib/storefront/store";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const slug = params.slug;
    if (slug === undefined || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(slug)) throw new AppError("product_not_found", 404);
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    const product = await getStorefrontProduct(env, shop, slug);
    return Response.json({ ok: true, product, publicDetails: shop.publicDetails, requestId: locals.requestId }, { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60", "Vary": "Accept-Language, Host" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
