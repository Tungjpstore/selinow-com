import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../lib/platform/bindings";
import { executeBuyerPrivacyRequest } from "../../../../../../../lib/tenants/customer-management";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 2 * 1024);
    rejectUnknownFields(body, ["confirmation", "kind"]);
    if (body.kind !== "export" && body.kind !== "anonymize") {
      return Response.json({ ok: false, code: "validation_failed", issues: ["privacy_kind_invalid"], requestId: locals.requestId }, { status: 400, headers: PRIVATE_RESPONSE_HEADERS });
    }
    if (body.kind === "anonymize" && body.confirmation !== "ANONYMIZE") {
      return Response.json({ ok: false, code: "validation_failed", issues: ["privacy_confirmation_invalid"], requestId: locals.requestId }, { status: 400, headers: PRIVATE_RESPONSE_HEADERS });
    }
    if (body.kind === "export" && Object.hasOwn(body, "confirmation")) {
      return Response.json({ ok: false, code: "validation_failed", issues: ["privacy_confirmation_unexpected"], requestId: locals.requestId }, { status: 400, headers: PRIVATE_RESPONSE_HEADERS });
    }
    const privacy = await executeBuyerPrivacyRequest({
      customerPublicId: requireResourceId(params.customerPublicId, "cus"),
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      kind: body.kind,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ ok: true, privacy, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
