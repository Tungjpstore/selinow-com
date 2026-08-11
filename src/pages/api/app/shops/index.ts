import type { APIRoute } from "astro";

import { cloudflareRequesterAddress } from "../../../../lib/auth/admission";
import { authenticateRequest, requireCsrfSession } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { PUBLIC_PLAN_CODES } from "../../../../lib/billing/plan-catalog";
import { normalizeOptionalCountryCode } from "../../../../lib/tenants/country";
import { normalizeShopName, normalizeSlug } from "../../../../lib/tenants/policy";
import { createShop, getShopCreationAdmission } from "../../../../lib/tenants/store";

type PublicPlanRow = {
  code: string;
  feature_flags_json: string;
  limits_json: string;
  name: string;
};

type PublicPlanOfferRow = {
  amount_minor: number;
  currency: string;
  interval: string;
  market_code: string;
  plan_code: string;
};

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const nowIso = new Date().toISOString();
    const [plansResult, offersResult, creationAdmission] = await Promise.all([
      env.PLATFORM_DB.prepare(`
        SELECT code, name, feature_flags_json, limits_json
        FROM plans
        WHERE is_active = 1 AND is_public = 1 AND is_assignable = 1
          AND code IN (?, ?)
      `).bind(...PUBLIC_PLAN_CODES).all<PublicPlanRow>(),
      env.PLATFORM_DB.prepare(`
        SELECT plans.code AS plan_code, prices.market_code, prices.currency,
          prices.amount_minor, prices.interval
        FROM plan_prices AS prices
        INNER JOIN plans ON plans.id = prices.plan_id
        WHERE plans.is_active = 1 AND plans.is_public = 1 AND plans.is_assignable = 1
          AND plans.code IN (?, ?)
          AND prices.is_active = 1
          AND prices.effective_from <= ?
          AND (prices.effective_to IS NULL OR prices.effective_to > ?)
        ORDER BY prices.market_code, prices.currency
      `).bind(...PUBLIC_PLAN_CODES, nowIso, nowIso).all<PublicPlanOfferRow>(),
      getShopCreationAdmission({ env, userId: auth.userId }),
    ]);
    const offersByPlan = new Map<string, PublicPlanOfferRow[]>();
    for (const offer of offersResult.results) {
      const offers = offersByPlan.get(offer.plan_code) ?? [];
      offers.push(offer);
      offersByPlan.set(offer.plan_code, offers);
    }
    const planRowsByCode = new Map(plansResult.results.map((plan) => [plan.code, plan]));
    const plans = PUBLIC_PLAN_CODES.flatMap((code) => {
      const plan = planRowsByCode.get(code);
      return plan === undefined ? [] : [{
        code: plan.code,
        features: safeJsonObject(plan.feature_flags_json),
        limits: safeJsonObject(plan.limits_json),
        name: plan.name,
        offers: (offersByPlan.get(plan.code) ?? []).map((offer) => ({
          amountMinor: offer.amount_minor,
          currency: offer.currency,
          interval: offer.interval,
          marketCode: offer.market_code,
        })),
      }];
    });
    return Response.json({ creationAdmission, ok: true, plans, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["businessCountry", "currency", "defaultLocale", "merchantCountry", "name", "planCode", "slug"]);
    const planCode = body.planCode === undefined ? "starter" : typeof body.planCode === "string" ? body.planCode : "";
    if (!(PUBLIC_PLAN_CODES as readonly string[]).includes(planCode)) {
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
      requesterAddress: cloudflareRequesterAddress(request),
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
