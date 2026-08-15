import type { APIRoute } from "astro";

import { AppError } from "../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";
import { issueTelegramMiniAppSession } from "../../../../../lib/channels/telegram-mini-app-session";

function requesterAddress(request: Request): string {
  const value = request.headers.get("CF-Connecting-IP")?.trim();
  return value !== undefined && value.length > 0 && value.length <= 128 ? value : "unknown";
}

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const shopPublicId = params.shopPublicId;
    if (shopPublicId === undefined) throw new AppError("resource_not_found", 404);
    const body = await readJsonObject(request, 20 * 1024);
    rejectUnknownFields(body, ["initData"]);
    if (typeof body.initData !== "string") throw new AppError("validation_failed", 400, ["init_data_required"]);
    const session = await issueTelegramMiniAppSession({
      env: getBindings(),
      initData: body.initData,
      requesterAddress: requesterAddress(request),
      requestId: locals.requestId,
      shopPublicId,
    });
    return Response.json({ ok: true, requestId: locals.requestId, session }, { headers: PRIVATE_RESPONSE_HEADERS, status: 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
