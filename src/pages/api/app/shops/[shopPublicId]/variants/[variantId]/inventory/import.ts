import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../../lib/catalog/policy";
import { confirmInventoryImport } from "../../../../../../../../lib/catalog/store";
import { AppError } from "../../../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../../lib/http/security";
import { getBindings } from "../../../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request, 2 * 1024 * 1024);
    rejectUnknownFields(body, ["data", "filename", "previewToken", "source"]);
    if (body.source !== "csv" && body.source !== "paste") throw new AppError("validation_failed", 400, ["source_invalid"]);
    const filename = body.filename === undefined ? null : body.filename;
    if (filename !== null && (typeof filename !== "string" || filename.length > 180 || /[/\\]/u.test(filename))) throw new AppError("validation_failed", 400, ["filename_invalid"]);
    if (typeof body.previewToken !== "string") throw new AppError("inventory_preview_invalid", 400);
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    const variantId = requireResourceId(params.variantId, "var");
    const result = await confirmInventoryImport({
      data: body.data,
      env,
      filename,
      idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
      previewToken: body.previewToken,
      requestId: locals.requestId,
      shopPublicId,
      source: body.source,
      userId: auth.userId,
      variantId,
    });
    const { created, ...batch } = result;
    return Response.json({ ...batch, ok: true, replayed: !created, requestId: locals.requestId }, { status: created ? 201 : 200, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
