import type { APIRoute } from "astro";

import { requireCsrfSession, authenticateRequest } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { attachProductImage, detachProductImage, listProductImages } from "../../../../../../../lib/media/assets";
import { readJsonObject } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
};

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const images = await listProductImages({
      env,
      productId: requireResourceId(params.productId, "prd"),
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ images, ok: true, requestId: locals.requestId }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    if (typeof body.mediaAssetPublicId !== "string") {
      return Response.json({ code: "validation_failed", ok: false }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const image = await attachProductImage({
      env,
      mediaAssetPublicId: body.mediaAssetPublicId,
      productId: requireResourceId(params.productId, "prd"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ image, ok: true, requestId: locals.requestId }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    if (typeof body.imageId !== "string") {
      return Response.json({ code: "validation_failed", ok: false }, { status: 400, headers: PRIVATE_HEADERS });
    }
    await detachProductImage({
      env,
      imageId: body.imageId,
      productId: requireResourceId(params.productId, "prd"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ok: true, requestId: locals.requestId }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
