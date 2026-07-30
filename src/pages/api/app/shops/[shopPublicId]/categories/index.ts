import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../../lib/auth/session";
import { parseCategoryInput } from "../../../../../../lib/catalog/http";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createCategory } from "../../../../../../lib/catalog/store";
import { readJsonObject } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const category = await createCategory({ data: parseCategoryInput(await readJsonObject(request)), env, shopPublicId: requireResourceId(params.shopPublicId, "shop"), userId: auth.userId });
    return Response.json({ category, ok: true, requestId: locals.requestId }, { status: 201, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
