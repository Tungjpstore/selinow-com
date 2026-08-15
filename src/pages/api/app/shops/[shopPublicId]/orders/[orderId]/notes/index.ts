import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../../lib/platform/bindings";
import { appendOrderNote, listOrderNotes } from "../../../../../../../../lib/commerce/order-notes";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const notes = await listOrderNotes({
      env,
      orderPublicId: requireResourceId(params.orderId, "order"),
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ notes, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS });
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
    rejectUnknownFields(body, ["body"]);
    if (typeof body.body !== "string") throw new AppError("validation_failed", 400, ["note_body_required"]);
    const note = await appendOrderNote({
      body: body.body,
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      orderPublicId: requireResourceId(params.orderId, "order"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ note, ok: true, requestId: locals.requestId }, { headers: PRIVATE_RESPONSE_HEADERS, status: 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
