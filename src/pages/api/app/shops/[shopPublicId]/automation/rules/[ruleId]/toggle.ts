import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../../lib/auth/session";
import { toggleAutomationRule } from "../../../../../../../../lib/automation/rules/service";
import { requireResourceId } from "../../../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 1_024);
    rejectUnknownFields(body, ["enabled", "expectedVersion"]);
    const result = await toggleAutomationRule({
      enabled: body.enabled,
      env,
      expectedVersion: body.expectedVersion,
      requestId: locals.requestId,
      ruleId: requireResourceId(params.ruleId, "rule"),
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
