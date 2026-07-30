import type { APIRoute } from "astro";

import {
  createAutomationTask,
  listAutomationTasks,
} from "../../../../../../lib/automation/api-service";
import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, [`${field}_required`]);
  }
  return value;
}

function parseCreateBody(body: Record<string, unknown>): {
  capabilityCode: string;
} {
  rejectUnknownFields(body, ["capabilityCode"]);
  return {
    capabilityCode: requireString(body.capabilityCode, "capability_code"),
  };
}

function parseListQuery(request: Request): {
  capabilityCode?: string;
  limit?: number;
  status?: string;
} {
  const searchParams = new URL(request.url).searchParams;
  const allowed = new Set(["capabilityCode", "limit", "status"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new AppError("validation_failed", 400, [`unknown_query:${key}`]);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new AppError("validation_failed", 400, [`${key}_duplicate`]);
    }
  }

  const capabilityCode = searchParams.get("capabilityCode") ?? undefined;
  const status = searchParams.get("status") ?? undefined;
  const rawLimit = searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    if (!/^[1-9][0-9]*$/u.test(rawLimit)) {
      throw new AppError("validation_failed", 400, ["limit_invalid"]);
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit)) {
      throw new AppError("validation_failed", 400, ["limit_invalid"]);
    }
  }

  return {
    ...(capabilityCode === undefined ? {} : { capabilityCode }),
    ...(limit === undefined ? {} : { limit }),
    ...(status === undefined ? {} : { status }),
  };
}

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const result = await listAutomationTasks({
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
    const result = await createAutomationTask({
      ...parseCreateBody(await readJsonObject(request, 4 * 1_024)),
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
