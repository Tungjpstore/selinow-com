import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { resumeShopDeletion } from "../../../../../../lib/operations/deletion";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    rejectUnknownFields(await readJsonObject(request), []);
    const deletion = await resumeShopDeletion({
      env,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ deletion, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_HEADERS,
      status: deletion.status === "completed" ? 200 : 202,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
