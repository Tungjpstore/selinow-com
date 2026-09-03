import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { setPrimaryDomain } from "../../../../../../../lib/domains/store";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

export const PUT: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    rejectUnknownFields(await readJsonObject(request), []);
    const domain = await setPrimaryDomain({
      domainId: requireResourceId(params.domainId, "dom"),
      env,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ domain, ok: true, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
