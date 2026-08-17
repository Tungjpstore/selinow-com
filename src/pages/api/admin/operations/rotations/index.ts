import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../lib/auth/session";
import { AppError } from "../../../../../lib/core/errors";
import { guardAdminMutationRate } from "../../../../../lib/http/admin-rate-limit";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import {
  createOperatorEncryptionRotation,
  listEncryptionRotationRuns,
  parseRotationKeyFamily,
  parseRotationScope,
  parseRotationVersion,
} from "../../../../../lib/operations/rotation-operator";
import { getBindings } from "../../../../../lib/platform/bindings";

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new AppError("rotation_validation_failed", 400, ["dry_run_invalid"]);
  }
  return value;
}

function optionalString(value: unknown, issue: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 128) {
    throw new AppError("rotation_validation_failed", 400, [issue]);
  }
  return value;
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const overview = await listEncryptionRotationRuns({ env, userId: auth.userId });
    return Response.json({ ...overview, ok: true, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    await guardAdminMutationRate({ env, family: "operations_rotations", request });
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 4 * 1_024);
    rejectUnknownFields(body, [
      "dryRun",
      "globalConfirmation",
      "keyFamily",
      "liveConfirmation",
      "scope",
      "shopPublicId",
      "sourceKeyVersion",
      "targetKeyVersion",
    ]);
    const result = await createOperatorEncryptionRotation({
      actorUserId: auth.userId,
      dryRun: requireBoolean(body.dryRun),
      env,
      globalConfirmation: optionalString(body.globalConfirmation, "global_confirmation_invalid"),
      idempotencyKey: request.headers.get("Idempotency-Key"),
      keyFamily: parseRotationKeyFamily(body.keyFamily),
      liveConfirmation: optionalString(body.liveConfirmation, "live_confirmation_invalid"),
      requestId: locals.requestId,
      scope: parseRotationScope(body.scope),
      shopPublicId: optionalString(body.shopPublicId, "shop_public_id_invalid"),
      sourceKeyVersion: parseRotationVersion(body.sourceKeyVersion),
      targetKeyVersion: parseRotationVersion(body.targetKeyVersion),
    });
    return Response.json({ ok: true, requestId: locals.requestId, result }, {
      status: 201,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
