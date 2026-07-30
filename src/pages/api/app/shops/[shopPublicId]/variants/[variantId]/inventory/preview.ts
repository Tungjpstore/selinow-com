import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../../lib/catalog/policy";
import { previewInventoryImport } from "../../../../../../../../lib/catalog/store";
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
    rejectUnknownFields(body, ["data", "filename", "source"]);
    if (body.source !== "csv" && body.source !== "paste") {
      throw new AppError("validation_failed", 400, ["source_invalid"]);
    }
    const filename = body.filename === undefined ? null : body.filename;
    if (filename !== null && (typeof filename !== "string" || filename.length > 180 || /[/\\]/u.test(filename))) {
      throw new AppError("validation_failed", 400, ["filename_invalid"]);
    }
    const preview = await previewInventoryImport({
      data: body.data,
      env,
      filename,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      source: body.source,
      userId: auth.userId,
      variantId: requireResourceId(params.variantId, "var"),
    });
    return Response.json({ ok: true, preview, requestId: locals.requestId }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
