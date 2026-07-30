import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { createDataExport, listDataExports, parseDataExportRequest } from "../../../../../../lib/operations/exports";
import { getBindings } from "../../../../../../lib/platform/bindings";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const exports = await listDataExports({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({ exports, ok: true, requestId: locals.requestId }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const body = await readJsonObject(request);
    rejectUnknownFields(body, ["acknowledgePlaintextRisk", "kind"]);
    const kind = parseDataExportRequest(body);
    const result = await createDataExport({
      acknowledgePlaintextRisk: kind === "inventory_keys_plaintext",
      env,
      kind,
      requestId: locals.requestId,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    return Response.json({
      downloadToken: result.downloadToken,
      export: result.export,
      ok: true,
      requestId: locals.requestId,
    }, { headers: PRIVATE_HEADERS, status: 201 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
