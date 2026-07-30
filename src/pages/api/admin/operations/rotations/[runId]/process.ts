import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import {
  parseRotationLimit,
  processOperatorEncryptionRotation,
} from "../../../../../../lib/operations/rotation-operator";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 1_024);
    rejectUnknownFields(body, ["limit"]);
    if (typeof params.runId !== "string") {
      throw new AppError("rotation_validation_failed", 400, ["run_id_invalid"]);
    }
    const result = await processOperatorEncryptionRotation({
      actorUserId: auth.userId,
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      limit: parseRotationLimit(body.limit),
      requestId: locals.requestId,
      runId: params.runId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, result }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
