import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { deleteCustomDomain } from "../../../../../../lib/domains/store";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    rejectUnknownFields(await readJsonObject(request), []);
    await deleteCustomDomain({
      domainId: requireResourceId(params.domainId, "dom"),
      env,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
