import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { deleteCustomDomain } from "../../../../../../lib/domains/store";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

function requireDeleteTargetId(value: string | undefined): string {
  return requireResourceId(value, value?.startsWith("dcl_") === true ? "dcl" : "dom");
}

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    rejectUnknownFields(await readJsonObject(request), []);
    await deleteCustomDomain({
      domainId: requireDeleteTargetId(params.domainId),
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
