import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";
import { resendMemberInvitation, revokeMemberInvitation } from "../../../../../../../lib/tenants/member-management";

async function mutationInput(locals: App.Locals, params: Record<string, string | undefined>, request: Request, action: "resend" | "revoke") {
  const env = getBindings();
  const auth = await requireCsrfSession(request, env);
  requireRecentAuth(auth);
  const body = await readJsonObject(request, 4 * 1024);
  rejectUnknownFields(body, ["expectedVersion"]);
  const common = {
    env,
    expectedVersion: body.expectedVersion as number,
    idempotencyKey: request.headers.get("Idempotency-Key"),
    invitationPublicId: requireResourceId(params.invitationPublicId, "inv"),
    requestId: locals.requestId,
    shopPublicId: requireResourceId(params.shopPublicId, "shop"),
    userId: auth.userId,
  };
  return action === "resend" ? resendMemberInvitation(common) : revokeMemberInvitation(common);
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const invitation = await mutationInput(locals, params, request, "resend");
    return Response.json({ invitation, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const DELETE: APIRoute = async ({ locals, params, request }) => {
  try {
    const result = await mutationInput(locals, params, request, "revoke");
    return Response.json({ invitation: result, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
