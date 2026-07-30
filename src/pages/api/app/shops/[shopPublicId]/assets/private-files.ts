import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../../lib/auth/session";
import {
  authorizePrivateDigitalAssetUpload,
  createPrivateDigitalAsset,
  MAX_PRIVATE_FILE_BYTES,
} from "../../../../../../lib/commerce/private-file-fulfillment";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { readBoundedBytes } from "../../../../../../lib/http/request";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const contentType = request.headers.get("Content-Type") ?? "";
    const filename = request.headers.get("X-File-Name") ?? "";
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    await authorizePrivateDigitalAssetUpload({ env, shopPublicId, userId: auth.userId });
    const bytes = await readBoundedBytes(request, MAX_PRIVATE_FILE_BYTES);
    const asset = await createPrivateDigitalAsset({
      bytes,
      contentType,
      env,
      filename,
      requestId: locals.requestId,
      shopPublicId,
      userId: auth.userId,
    });
    return Response.json({
      asset: {
        assetId: asset.assetId,
        assetVersionId: asset.assetVersionId,
        byteSize: asset.byteSize,
        contentSha256: asset.contentSha256,
        contentType: asset.contentType,
        filename: asset.filename,
        version: asset.version,
      },
      ok: true,
      requestId: locals.requestId,
    }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
