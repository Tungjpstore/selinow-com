import type { APIRoute } from "astro";

import { resumeAutomationTask } from "../../../../../../../lib/automation/api-service";
import { requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function requireTaskId(value: string | undefined): string {
  if (value === undefined || value === "") throw new AppError("resource_not_found", 404);
  return value;
}

function requireExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  }
  return value;
}

function parseResumeBody(body: Record<string, unknown>): {
  expectedVersion: number;
} {
  rejectUnknownFields(body, ["expectedVersion"]);
  return {
    expectedVersion: requireExpectedVersion(body.expectedVersion),
  };
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const result = await resumeAutomationTask({
      ...parseResumeBody(await readJsonObject(request, 4 * 1_024)),
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      taskId: requireTaskId(params.taskId),
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
