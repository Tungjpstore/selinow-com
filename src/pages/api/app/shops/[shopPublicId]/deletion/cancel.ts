import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { cancelShopDeletion } from "../../../../../../lib/operations/deletion";
import { safeOperationsReference } from "../../../../../../lib/operations/incidents";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function expectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  }
  return value;
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 2 * 1_024);
    rejectUnknownFields(body, ["deletionRequestId", "expectedVersion", "reasonCode"]);
    const deletion = await cancelShopDeletion({
      deletionRequestId: safeOperationsReference(body.deletionRequestId, "deletion_request_id_invalid"),
      env,
      expectedVersion: expectedVersion(body.expectedVersion),
      idempotencyKey: request.headers.get("Idempotency-Key"),
      reasonCode: body.reasonCode,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ deletion, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
