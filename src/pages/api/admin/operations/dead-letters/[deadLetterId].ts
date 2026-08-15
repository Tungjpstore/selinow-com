import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../lib/auth/session";
import { AppError } from "../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import {
  acknowledgeDeadLetter,
  requestGeneratedLicenseDeadLetterRetry,
  requestGenericDeadLetterReplay,
  requestDeadLetterRetry,
  resolveDeadLetter,
  type DeadLetterView,
  type GeneratedLicenseDeadLetterView,
} from "../../../../../lib/operations/dead-letters";
import { safeOperationsReference } from "../../../../../lib/operations/incidents";
import { getBindings } from "../../../../../lib/platform/bindings";
import { getPlatformAdminRole } from "../../../../../lib/tenants/store";

function requireExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError("operations_validation_failed", 400, ["expected_version_invalid"]);
  }
  return value;
}

function requireShopId(value: unknown): string | null {
  return value === null ? null : safeOperationsReference(value, "shop_id_invalid");
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const adminRole = await getPlatformAdminRole({ env, userId: auth.userId });
    if (adminRole === null) {
      throw new AppError("authorization_denied", 403);
    }
    const body = await readJsonObject(request, 2 * 1_024);
    rejectUnknownFields(body, ["action", "expectedVersion", "resolutionCode", "shopId"]);
    const common = {
      actorUserId: auth.userId,
      env,
      id: safeOperationsReference(params.deadLetterId, "dead_letter_id_invalid"),
      requestId: locals.requestId,
      shopId: requireShopId(body.shopId),
    };
    let deadLetter: DeadLetterView | GeneratedLicenseDeadLetterView;
    let operationId: string | undefined;
    let replayed: boolean | undefined;
    if (body.action === "retry_generated_license") {
      if (adminRole !== "owner" && adminRole !== "risk") {
        throw new AppError("authorization_denied", 403);
      }
      if (common.shopId === null) {
        throw new AppError("operations_validation_failed", 400, ["shop_id_required"]);
      }
      const result = await requestGeneratedLicenseDeadLetterRetry({
        ...common,
        idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
        shopId: common.shopId,
      });
      ({ deadLetter, operationId, replayed } = result);
    } else if (body.action === "acknowledge") {
      deadLetter = await acknowledgeDeadLetter({
        ...common,
        expectedVersion: requireExpectedVersion(body.expectedVersion),
      });
    } else if (body.action === "request_retry") {
      deadLetter = await requestDeadLetterRetry({
        ...common,
        expectedVersion: requireExpectedVersion(body.expectedVersion),
      });
    } else if (body.action === "resolve") {
      deadLetter = await resolveDeadLetter({
        ...common,
        expectedVersion: requireExpectedVersion(body.expectedVersion),
        resolutionCode: safeOperationsReference(body.resolutionCode, "resolution_code_invalid"),
      });
    } else if (body.action === "replay") {
      if (adminRole !== "owner" && adminRole !== "risk") {
        throw new AppError("authorization_denied", 403);
      }
      if (common.shopId === null) {
        throw new AppError("operations_validation_failed", 400, ["shop_id_required"]);
      }
      const result = await requestGenericDeadLetterReplay({
        ...common,
        actorUserId: auth.userId,
        expectedVersion: requireExpectedVersion(body.expectedVersion),
        idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
        shopId: common.shopId,
      });
      ({ deadLetter, operationId, replayed } = result);
    } else {
      throw new AppError("operations_validation_failed", 400, ["action_invalid"]);
    }
    return Response.json({
      deadLetter,
      ok: true,
      ...(operationId === undefined ? {} : { operationId, replayed }),
      requestId: locals.requestId,
    }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
      status: (body.action === "replay" || body.action === "retry_generated_license") && replayed === false ? 202 : 200,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
