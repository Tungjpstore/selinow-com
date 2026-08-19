import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession } from "../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";
import { getSellerStorefrontSettings, updateSellerStorefrontSettings } from "../../../../../lib/tenants/storefront-settings";

const ALLOWED = ["accentColor", "announcement", "deliveryText", "description", "expectedVersion", "footerText", "headline", "logoUrl", "primaryColor", "seoDescription", "seoTitle", "showExactStock", "supportText", "templateId"];
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const settings = await getSellerStorefrontSettings({ env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ ok: true, requestId: locals.requestId, settings }, { headers: PRIVATE_HEADERS });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ALLOWED);
    const { expectedVersion, ...data } = body;
    const settings = await updateSellerStorefrontSettings({ data, env, expectedVersion, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ ok: true, requestId: locals.requestId, settings }, { headers: PRIVATE_HEADERS });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
