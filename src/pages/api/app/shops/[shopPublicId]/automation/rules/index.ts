import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { createAutomationRule, listAutomationRules } from "../../../../../../../lib/automation/rules/service";
import type { RuleTriggerType } from "../../../../../../../lib/automation/rules/types";
import { RULE_TRIGGER_TYPES } from "../../../../../../../lib/automation/rules/types";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function parseListQuery(request: Request): {
  enabled?: boolean;
  limit?: number;
  triggerType?: RuleTriggerType;
} {
  const searchParams = new URL(request.url).searchParams;
  const allowed = new Set(["enabled", "limit", "triggerType"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new AppError("validation_failed", 400, [`unknown_query:${key}`]);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new AppError("validation_failed", 400, [`${key}_duplicate`]);
    }
  }

  const rawLimit = searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    if (!/^[1-9][0-9]*$/u.test(rawLimit)) {
      throw new AppError("validation_failed", 400, ["limit_invalid"]);
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError("validation_failed", 400, ["limit_invalid"]);
    }
  }

  const rawTriggerType = searchParams.get("triggerType");
  let triggerType: RuleTriggerType | undefined;
  if (rawTriggerType !== null) {
    if (!(RULE_TRIGGER_TYPES as readonly string[]).includes(rawTriggerType)) {
      throw new AppError("validation_failed", 400, ["trigger_type_invalid"]);
    }
    triggerType = rawTriggerType as RuleTriggerType;
  }

  const rawEnabled = searchParams.get("enabled");
  let enabled: boolean | undefined;
  if (rawEnabled !== null) {
    if (rawEnabled !== "0" && rawEnabled !== "1") {
      throw new AppError("validation_failed", 400, ["enabled_invalid"]);
    }
    enabled = rawEnabled === "1";
  }

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(limit === undefined ? {} : { limit }),
    ...(triggerType === undefined ? {} : { triggerType }),
  };
}

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const result = await listAutomationRules({
      env,
      ...parseListQuery(request),
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

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1_024);
    rejectUnknownFields(body, ["actions", "conditions", "enabled", "name", "triggerType"]);
    const result = await createAutomationRule({
      body,
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_HEADERS,
      status: result.replayed ? 200 : 201,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
