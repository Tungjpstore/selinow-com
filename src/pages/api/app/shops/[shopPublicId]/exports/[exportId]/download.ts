import type { APIRoute } from "astro";

import { requireCsrfSession, requireRecentAuth } from "../../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../../lib/http/security";
import { consumeDataExportDownload, parseDownloadToken } from "../../../../../../../lib/operations/exports";
import { getBindings } from "../../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth, 5);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["token"]);
    const result = await consumeDataExportDownload({
      env,
      exportId: requireResourceId(params.exportId, "exp"),
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      token: parseDownloadToken(body.token),
      userId: auth.userId,
    });
    return new Response(result.bytes, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
