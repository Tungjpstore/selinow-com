import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createProductWithInitialVariant } from "../../../../../../lib/catalog/store";
import { AppError } from "../../../../../../lib/core/errors";
import { sha256Hex } from "../../../../../../lib/core/crypto";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { findPresetById, ONBOARDING_PRODUCT_PRESETS } from "../../../../../../lib/onboarding/presets";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { getShopForMember } from "../../../../../../lib/tenants/store";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  }
  return value;
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    await requireCsrfSession(request, env);
    return Response.json({
      ok: true,
      presets: ONBOARDING_PRODUCT_PRESETS,
      requestId: locals.requestId,
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const idempotencyKey = requireIdempotencyKey(request.headers.get("Idempotency-Key"));

    const body = await readJsonObject(request, 64 * 1024);
    rejectUnknownFields(body, ["presetId"]);

    if (typeof body.presetId !== "string") {
      throw new AppError("validation_failed", 400, ["preset_id_required"]);
    }

    const preset = findPresetById(body.presetId);
    if (preset === undefined) {
      throw new AppError("validation_failed", 404, ["preset_not_found"]);
    }

    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    // OB-A2: presets are vertical-scoped — a preset from another selling
    // category must never seed a shop's first product.
    const member = await getShopForMember({
      capability: "shop:update",
      env,
      shopPublicId,
      subscriptionAction: "draft_setup",
      userId: auth.userId,
    });
    if (preset.vertical !== member.shop.vertical) {
      throw new AppError("validation_failed", 400, ["preset_vertical_mismatch"]);
    }
    // Derive all generated identifiers from the replay key so a retried request
    // cannot create a different slug/SKU or exceed the provider key limit.
    const seedDigest = await sha256Hex(`${idempotencyKey}\0${preset.id}`);
    const uniqueSuffix = seedDigest.slice(0, 10).toLowerCase();
    // 1. Create product and initial variant
    const result = await createProductWithInitialVariant({
      data: {
        categoryId: null,
        description: preset.description,
        fulfillmentType: preset.fulfillmentType,
        slug: `${preset.slug}-${uniqueSuffix}`,
        status: "active",
        title: preset.title,
      },
      env,
      idempotencyKey,
      initialVariant: {
        compareAtMinor: null,
        currency: preset.currency,
        maxPerOrder: 10,
        minPerOrder: 1,
        optionsJson: "{}",
        priceMinor: preset.priceMinor,
        sku: `${preset.sku}-${uniqueSuffix.toUpperCase()}`,
        status: "active",
        title: "Mặc định",
      },
      requestId: locals.requestId,
      shopPublicId,
      userId: auth.userId,
    });

    return Response.json({
      importedKeysCount: 0,
      ok: true,
      product: result.product,
      requestId: locals.requestId,
      variant: result.variant,
    }, { headers: PRIVATE_HEADERS, status: 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
