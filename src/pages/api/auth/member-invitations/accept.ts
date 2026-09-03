import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { acceptMemberInvitation } from "../../../../lib/tenants/member-management";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request, 4 * 1024);
    rejectUnknownFields(body, ["token"]);
    if (typeof body.token !== "string") throw new AppError("validation_failed", 400, ["invitation_token_required"]);
    const member = await acceptMemberInvitation({ env, requestId: locals.requestId, token: body.token, userId: auth.userId });
    return Response.json({ member, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
