import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { normalizeOptionalCountryCode } from "../../../../lib/tenants/country";
import { normalizeShopName, normalizeSlug } from "../../../../lib/tenants/policy";
import { getShopForMember, updateShopProfile } from "../../../../lib/tenants/store";

function requireShopPublicId(value: string | undefined): string {
  if (value === undefined || !/^shop_[0-9a-f-]{36}$/u.test(value)) {
    throw new AppError("tenant_not_found", 404);
  }
  return value;
}

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const result = await getShopForMember({
      capability: "shop:read",
      env,
      shopPublicId: requireShopPublicId(params.shopPublicId),
      userId: auth.userId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, shop: result.shop }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["businessCountry", "currency", "defaultLocale", "merchantCountry", "name", "slug"]);
    const businessCountry = normalizeOptionalCountryCode(body.businessCountry, "business_country_invalid");
    const merchantCountry = normalizeOptionalCountryCode(body.merchantCountry, "merchant_country_invalid");
    const shop = await updateShopProfile({
      ...(businessCountry === undefined ? {} : { businessCountry }),
      ...(body.currency === undefined ? {} : { currency: body.currency }),
      ...(body.defaultLocale === undefined ? {} : { defaultLocale: body.defaultLocale }),
      env,
      ...(merchantCountry === undefined ? {} : { merchantCountry }),
      ...(body.name === undefined ? {} : { name: normalizeShopName(body.name) }),
      ...(body.slug === undefined ? {} : { slug: normalizeSlug(body.slug) }),
      requestId: locals.requestId,
      shopPublicId: requireShopPublicId(params.shopPublicId),
      userId: auth.userId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, shop }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
