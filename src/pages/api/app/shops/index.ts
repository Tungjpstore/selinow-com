import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { normalizeOptionalCountryCode } from "../../../../lib/tenants/country";
import { normalizeShopName, normalizeSlug } from "../../../../lib/tenants/policy";
import { createShop } from "../../../../lib/tenants/store";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["businessCountry", "currency", "defaultLocale", "merchantCountry", "name", "planCode", "slug"]);
    const planCode = typeof body.planCode === "string" ? body.planCode : "store";
    if (!new Set(["bot", "store", "business"]).has(planCode)) {
      throw new AppError("validation_failed", 400, ["plan_invalid"]);
    }
    const businessCountry = normalizeOptionalCountryCode(body.businessCountry, "business_country_invalid");
    const merchantCountry = normalizeOptionalCountryCode(body.merchantCountry, "merchant_country_invalid");
    const result = await createShop({
      ...(businessCountry === undefined ? {} : { businessCountry }),
      ...(body.currency === undefined ? {} : { currency: body.currency }),
      ...(body.defaultLocale === undefined ? {} : { defaultLocale: body.defaultLocale }),
      env,
      idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
      ...(merchantCountry === undefined ? {} : { merchantCountry }),
      name: normalizeShopName(body.name),
      planCode,
      requestId: locals.requestId,
      slug: normalizeSlug(body.slug),
      userId: auth.userId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, shop: result.shop }, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
