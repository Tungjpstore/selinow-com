import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { guardAdminMutationRate } from "../../../../../../lib/http/admin-rate-limit";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { applyDeletionLegalHold } from "../../../../../../lib/operations/deletion";
import { safeOperationsReference } from "../../../../../../lib/operations/incidents";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function action(value: unknown): "release" | "set" {
  if (value !== "release" && value !== "set") {
    throw new AppError("validation_failed", 400, ["legal_hold_action_invalid"]);
  }
  return value;
}

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
    await guardAdminMutationRate({ env, family: "operations_deletions", request });
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request, 2 * 1_024);
    rejectUnknownFields(body, [
      "action",
      "evidenceReference",
      "expectedVersion",
      "holdUntil",
      "reasonCode",
      "shopPublicId",
    ]);
    const result = await applyDeletionLegalHold({
      action: action(body.action),
      actorUserId: auth.userId,
      deletionRequestId: safeOperationsReference(params.deletionRequestId, "deletion_request_id_invalid"),
      env,
      evidenceReference: body.evidenceReference,
      expectedVersion: expectedVersion(body.expectedVersion),
      holdUntil: body.holdUntil,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      reasonCode: body.reasonCode,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(
        typeof body.shopPublicId === "string" ? body.shopPublicId : undefined,
        "shop",
      ),
    });
    return Response.json({ legalHold: result, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
