import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../lib/catalog/policy";
import { createMediaAsset, MAX_MEDIA_IMAGE_BYTES } from "../../../../../lib/media/assets";
import { readBoundedBytes } from "../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const contentType = request.headers.get("Content-Type") ?? "";
    const kindHeader = request.headers.get("X-Media-Kind") ?? "product_image";
    const kind = kindHeader === "shop_logo" || kindHeader === "hero_banner" ? kindHeader : "product_image";
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    const bytes = await readBoundedBytes(request, MAX_MEDIA_IMAGE_BYTES);
    const asset = await createMediaAsset({
      bytes,
      contentType,
      env,
      kind,
      requestId: locals.requestId,
      shopPublicId,
      userId: auth.userId,
    });
    return Response.json({
      asset: {
        byteSize: asset.byteSize,
        contentType: asset.contentType,
        id: asset.id,
        kind: asset.kind,
        publicId: asset.publicId,
        url: `/media/${asset.publicId}`,
      },
      ok: true,
      requestId: locals.requestId,
    }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
