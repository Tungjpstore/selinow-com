import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import {
  deleteAutomationRule,
  getAutomationRule,
  updateAutomationRule,
} from "../../../../../../../lib/automation/rules/service";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const result = await getAutomationRule({
      env,
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

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1_024);
    rejectUnknownFields(body, ["actions", "conditions", "expectedVersion", "name", "triggerType"]);
    const result = await updateAutomationRule({
      body,
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

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 1_024);
    rejectUnknownFields(body, ["expectedVersion"]);
    await deleteAutomationRule({
      env,
      expectedVersion: body.expectedVersion,
      requestId: locals.requestId,
      ruleId: requireResourceId(params.ruleId, "rule"),
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return new Response(null, { headers: PRIVATE_HEADERS, status: 204 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
