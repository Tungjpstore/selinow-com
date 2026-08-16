import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { setVariantStockLevel } from "../../../../../../../lib/commerce/shipping";
import { readJsonObject } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";
import { getShopForMember } from "../../../../../../../lib/tenants/store";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

/** Physical stock levels for one product's variants (editor display). */
export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const member = await getShopForMember({
      capability: "catalog:read",
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    const rows = await env.PLATFORM_DB.prepare(`
      SELECT variant_stock_levels.variant_id AS variantId,
        variant_stock_levels.on_hand AS onHand, variant_stock_levels.reserved AS reserved
      FROM variant_stock_levels
      INNER JOIN product_variants
        ON product_variants.shop_id = variant_stock_levels.shop_id
        AND product_variants.id = variant_stock_levels.variant_id
      WHERE variant_stock_levels.shop_id = ? AND product_variants.product_id = ?
      ORDER BY product_variants.created_at, product_variants.id
    `).bind(member.row.shop_id, requireResourceId(params.productId, "prd"))
      .all<{ onHand: number; reserved: number; variantId: string }>();
    return Response.json({ levels: rows.results, ok: true, requestId: locals.requestId }, { headers: PRIVATE_HEADERS });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    if (typeof body.variantId !== "string" || typeof body.onHand !== "number") {
      return Response.json({ code: "validation_failed", ok: false }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const stock = await setVariantStockLevel({
      env,
      onHand: body.onHand,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
      variantId: body.variantId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, stock }, { headers: PRIVATE_HEADERS });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
