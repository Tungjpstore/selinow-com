import type { APIRoute } from "astro";

import { hmacToken } from "../../../../lib/core/crypto";
import { AppError } from "../../../../lib/core/errors";
import { normalizeCustomerEmail } from "../../../../lib/commerce/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { guardAnonymousOrderLookup } from "../../../../lib/storefront/abuse";
import { resolveStorefrontShop } from "../../../../lib/storefront/store";

/**
 * Buyer order-history lookup by checkout email. Matches the shop-scoped
 * HMAC written at checkout (never the email itself); returns masked
 * summaries only — no tokens, keys, or addresses. Opening an order still
 * goes through the per-order recovery flow. Uniform success payload whether
 * or not the email matches, so the endpoint cannot enumerate buyers.
 */

const LOOKUP_WINDOW_DAYS = 180;

type LookupOrderRow = {
  createdAt: string;
  currency: string;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  status: string;
  totalMinor: number;
};

function assertSameOrigin(request: Request): void {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (origin !== expected || fetchSite === "cross-site") {
    throw new AppError("order_lookup_origin_invalid", 403);
  }
}

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    assertSameOrigin(request);
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["email", "turnstileToken"]);
    const email = normalizeCustomerEmail(body.email);
    if (email === null) throw new AppError("validation_failed", 400, ["email_invalid"]);
    await guardAnonymousOrderLookup({ env, request, shop, turnstileToken: body.turnstileToken });
    const lookupHash = await hmacToken(env.IDENTIFIER_HMAC_SECRET, `order-email-lookup:v1:${shop.id}`, email);
    const cutoff = new Date(Date.now() - LOOKUP_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    const result = await env.PLATFORM_DB.prepare(`
      SELECT orders.public_id AS orderId, orders.order_number AS orderNumber, orders.status,
        orders.payment_status AS paymentStatus, orders.total_minor AS totalMinor,
        orders.currency, orders.created_at AS createdAt
      FROM orders
      WHERE orders.shop_id = ?
        AND orders.customer_email_lookup_hash = ?
        AND orders.created_at >= ?
      ORDER BY orders.created_at DESC, orders.id DESC
      LIMIT 20
    `).bind(shop.id, lookupHash, cutoff).all<LookupOrderRow>();
    return Response.json(
      {
        ok: true,
        orders: result.results.map((row) => ({
          createdAt: row.createdAt,
          currency: row.currency,
          orderId: row.orderId,
          orderNumber: row.orderNumber,
          paymentStatus: row.paymentStatus,
          status: row.status,
          totalMinor: row.totalMinor,
        })),
        requestId: locals.requestId,
      },
      { headers: { ...PRIVATE_RESPONSE_HEADERS, "Referrer-Policy": "no-referrer" } },
    );
  } catch (error) {
    const response = createCaughtErrorResponse(error, locals.requestId);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
};
