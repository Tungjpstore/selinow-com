import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { AppError } from "../../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";
import {
  issueMemberInvitation,
  listMemberInvitations,
} from "../../../../../../../lib/tenants/member-management";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";

function parseRole(value: unknown): "manager" | "support" | "viewer" {
  if (value !== "manager" && value !== "support" && value !== "viewer") {
    throw new AppError("validation_failed", 400, ["member_role_invalid"]);
  }
  return value;
}

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const invitations = await listMemberInvitations({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ invitations, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["email", "role"]);
    if (typeof body.email !== "string") throw new AppError("validation_failed", 400, ["email_required"]);
    const result = await issueMemberInvitation({
      email: body.email,
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      requestId: locals.requestId,
      role: parseRole(body.role),
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ...result, ok: true, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
      status: result.replayed ? 200 : 201,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
