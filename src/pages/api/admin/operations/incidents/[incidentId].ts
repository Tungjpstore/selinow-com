import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../lib/auth/session";
import { AppError } from "../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import {
  acknowledgeIncident,
  resolveIncident,
  safeOperationsReference,
  type IncidentView,
} from "../../../../../lib/operations/incidents";
import { getBindings } from "../../../../../lib/platform/bindings";
import { isPlatformAdmin } from "../../../../../lib/tenants/store";

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
    if (!(await isPlatformAdmin({ env, userId: auth.userId }))) {
      throw new AppError("authorization_denied", 403);
    }
    const body = await readJsonObject(request, 2 * 1_024);
    rejectUnknownFields(body, ["action", "expectedVersion", "resolutionCode", "shopId"]);
    const incidentId = safeOperationsReference(params.incidentId, "incident_id_invalid");
    const common = {
      actorUserId: auth.userId,
      env,
      expectedVersion: requireExpectedVersion(body.expectedVersion),
      incidentId,
      requestId: locals.requestId,
      shopId: requireShopId(body.shopId),
    };
    let incident: IncidentView;
    if (body.action === "acknowledge") {
      incident = await acknowledgeIncident(common);
    } else if (body.action === "resolve") {
      incident = await resolveIncident({
        ...common,
        resolutionCode: safeOperationsReference(body.resolutionCode, "resolution_code_invalid"),
      });
    } else {
      throw new AppError("operations_validation_failed", 400, ["action_invalid"]);
    }
    return Response.json({ incident, ok: true, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
