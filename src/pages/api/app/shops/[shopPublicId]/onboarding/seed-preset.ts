import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { confirmInventoryImport, createProductWithInitialVariant, previewInventoryImport } from "../../../../../../lib/catalog/store";
import { AppError } from "../../../../../../lib/core/errors";
import { createId } from "../../../../../../lib/core/ids";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { findPresetById, ONBOARDING_PRODUCT_PRESETS } from "../../../../../../lib/onboarding/presets";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { getShopForMember } from "../../../../../../lib/tenants/store";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

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
    const uniqueSuffix = createId("seed").slice(-6).toLowerCase();
    const idempotencyKey = `seed-preset-${preset.id}-${createId("idm")}`;

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

    let importedKeysCount = 0;

    // 2. If license_key and has sampleKeys, import them
    if (preset.fulfillmentType === "license_key" && preset.sampleKeys.length > 0) {
      const keysData = preset.sampleKeys.join("\n");
      const preview = await previewInventoryImport({
        data: keysData,
        env,
        filename: null,
        shopPublicId,
        source: "paste",
        userId: auth.userId,
        variantId: result.variant.id,
      });

      const importResult = await confirmInventoryImport({
        data: keysData,
        env,
        filename: null,
        idempotencyKey: `seed-keys-${result.variant.id}-${createId("idm")}`,
        previewToken: preview.previewToken,
        requestId: locals.requestId,
        shopPublicId,
        source: "paste",
        userId: auth.userId,
        variantId: result.variant.id,
      });

      importedKeysCount = importResult.acceptedCount;
    }

    return Response.json({
      importedKeysCount,
      ok: true,
      product: result.product,
      requestId: locals.requestId,
      variant: result.variant,
    }, { headers: PRIVATE_HEADERS, status: 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
