import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { suspendMember, updateMemberRole } from "../../../../../../lib/tenants/member-management";

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["expectedVersion", "role"]);
    const result = await updateMemberRole({
      env,
      expectedVersion: body.expectedVersion as number,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      memberPublicId: requireResourceId(params.memberPublicId, "mbr"),
      newRole: body.role as "manager" | "support" | "viewer",
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ member: result, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["expectedVersion"]);
    const result = await suspendMember({
      env,
      expectedVersion: body.expectedVersion as number,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      memberPublicId: requireResourceId(params.memberPublicId, "mbr"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ member: result, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
