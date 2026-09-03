import type { APIRoute } from "astro";

import { cloudflareRequesterAddress } from "../../../../lib/auth/admission";
import { authenticateRequest, requireCsrfSession } from "../../../../lib/auth/session";
import {
  EFFECTIVE_PLAN_OFFER_SQL_PREDICATE,
  projectLatestSellablePlanOffers,
  SELLABLE_PUBLIC_PLAN_SQL_PREDICATE,
  type PlanOfferRevision,
  type SellablePlanOffer,
} from "../../../../lib/billing/catalog";
import { PUBLIC_PLAN_CODES } from "../../../../lib/billing/plan-catalog";
import { AppError } from "../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { normalizeOptionalCountryCode } from "../../../../lib/tenants/country";
import { normalizeShopName, normalizeSlug } from "../../../../lib/tenants/policy";
import { createShop, getShopCreationAdmission } from "../../../../lib/tenants/store";

type PublicPlanRow = {
  code: string;
  feature_flags_json: string;
  limits_json: string;
  name: string;
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
        WHERE ${SELLABLE_PUBLIC_PLAN_SQL_PREDICATE}
          AND code IN (?, ?)
      `).bind(...PUBLIC_PLAN_CODES).all<PublicPlanRow>(),
      env.PLATFORM_DB.prepare(`
        SELECT plan_prices.id, plans.code AS planCode,
          plan_prices.market_code AS marketCode, plan_prices.currency,
          plan_prices.amount_minor AS amountMinor, plan_prices.interval,
          plan_prices.provider_code AS providerCode,
          plan_prices.provider_price_ref AS providerPriceRef,
          plan_prices.effective_from AS effectiveFrom, plan_prices.version
        FROM plan_prices
        INNER JOIN plans ON plans.id = plan_prices.plan_id
        WHERE ${SELLABLE_PUBLIC_PLAN_SQL_PREDICATE}
          AND plans.code IN (?, ?)
          AND plan_prices.market_code IN ('vn', 'global')
          AND plan_prices.currency IN ('VND', 'USD')
          AND ${EFFECTIVE_PLAN_OFFER_SQL_PREDICATE}
        ORDER BY plans.code, plan_prices.market_code, plan_prices.currency, plan_prices.interval,
          plan_prices.effective_from DESC, plan_prices.version DESC, plan_prices.id DESC
      `).bind(...PUBLIC_PLAN_CODES, nowIso, nowIso).all<PlanOfferRevision>(),
      getShopCreationAdmission({ env, userId: auth.userId }),
    ]);
    const offersByPlan = new Map<string, SellablePlanOffer[]>();
    for (const { planCode, ...offer } of projectLatestSellablePlanOffers(offersResult.results)) {
      const offers = offersByPlan.get(planCode) ?? [];
      offers.push(offer);
      offersByPlan.set(planCode, offers);
    }
    const planRowsByCode = new Map(plansResult.results.map((plan) => [plan.code, plan]));
    const plans = PUBLIC_PLAN_CODES.flatMap((code) => {
      const plan = planRowsByCode.get(code);
      return plan === undefined ? [] : [{
        code: plan.code,
        features: safeJsonObject(plan.feature_flags_json),
        limits: safeJsonObject(plan.limits_json),
        name: plan.name,
        offers: offersByPlan.get(plan.code) ?? [],
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
        rejectUnknownFields(body, ["businessCountry", "channels", "currency", "defaultLocale", "merchantCountry", "name", "planCode", "slug", "templateId", "vertical"]);
    const planCode = body.planCode === undefined ? "starter" : typeof body.planCode === "string" ? body.planCode : "";
    if (!(PUBLIC_PLAN_CODES as readonly string[]).includes(planCode)) {
      throw new AppError("validation_failed", 400, ["plan_invalid"]);
    }
    const businessCountry = normalizeOptionalCountryCode(body.businessCountry, "business_country_invalid");
    const merchantCountry = normalizeOptionalCountryCode(body.merchantCountry, "merchant_country_invalid");
    // EX5.2: onboarding persists the chosen selling vertical (advisory since 0102).
    const vertical = body.vertical === undefined || body.vertical === null ? undefined
      : body.vertical === "digital" || body.vertical === "physical" || body.vertical === "booking" ? body.vertical
        : (() => { throw new AppError("validation_failed", 400, ["vertical_invalid"]); })();
    // OB-B1 one-request provisioning: optional template pick + channel choice.
    const templateId = body.templateId === undefined || body.templateId === null ? undefined
      : typeof body.templateId === "string" ? body.templateId
        : (() => { throw new AppError("validation_failed", 400, ["storefront_template_invalid"]); })();
    const channels = parseChannels(body.channels);
    const result = await createShop({
      ...(businessCountry === undefined ? {} : { businessCountry }),
      ...(channels === undefined ? {} : { channels }),
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
      ...(templateId === undefined ? {} : { templateId }),
      userId: auth.userId,
      ...(vertical === undefined ? {} : { vertical }),
    });
    return Response.json({ ok: true, requestId: locals.requestId, shop: result.shop }, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

function parseChannels(value: unknown): { customDomainPreference: "connect" | "later" | "skip"; telegramEnabled: boolean; websiteEnabled: boolean } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("validation_failed", 400, ["channels_invalid"]);
  }
  const channels = value as Record<string, unknown>;
  rejectUnknownFields(channels, ["customDomainPreference", "telegramEnabled", "websiteEnabled"]);
  const websiteEnabled = channels.websiteEnabled;
  const telegramEnabled = channels.telegramEnabled;
  if (typeof websiteEnabled !== "boolean" || typeof telegramEnabled !== "boolean") {
    throw new AppError("validation_failed", 400, ["channels_invalid"]);
  }
  const preference = channels.customDomainPreference ?? "later";
  if (preference !== "connect" && preference !== "later" && preference !== "skip") {
    throw new AppError("validation_failed", 400, ["custom_domain_preference_invalid"]);
  }
  return { customDomainPreference: preference, telegramEnabled, websiteEnabled };
}
