import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../../../lib/auth/session";
import { configurePrivateFilePolicy } from "../../../../../../../lib/commerce/private-file-fulfillment";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { getBindings } from "../../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["assetVersionId", "entitlementTtlSeconds", "grantTtlSeconds", "maxDownloads"]);
    const result = await configurePrivateFilePolicy({
      assetVersionId: typeof body.assetVersionId === "string" ? body.assetVersionId : "",
      entitlementTtlSeconds: body.entitlementTtlSeconds === null || body.entitlementTtlSeconds === undefined
        ? null
        : typeof body.entitlementTtlSeconds === "number" ? body.entitlementTtlSeconds : -1,
      env,
      grantTtlSeconds: typeof body.grantTtlSeconds === "number" ? body.grantTtlSeconds : -1,
      maxDownloads: typeof body.maxDownloads === "number" ? body.maxDownloads : -1,
      productId: requireResourceId(params.productId, "prd"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ok: true, policy: result, requestId: locals.requestId }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
