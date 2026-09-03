import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { publishSellerStorefrontSettings } from "../../../../../../lib/tenants/storefront-settings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["expectedVersion"]);
    const settings = await publishSellerStorefrontSettings({
      env,
      expectedVersion: body.expectedVersion,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, settings }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
