import type { APIRoute } from "astro";

import { readJsonObject, rejectUnknownFields } from "../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../lib/http/security";
import {
  createPublicAbuseReport,
  parseAbuseCategory,
  parsePublicAbuseTargetKind,
} from "../../../lib/operations/abuse";
import { getBindings } from "../../../lib/platform/bindings";
import { resolveStorefrontShop } from "../../../lib/storefront/store";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const shop = await resolveStorefrontShop(request, env);
    const body = await readJsonObject(request, 8 * 1_024);
    rejectUnknownFields(body, [
      "category",
      "productSlug",
      "reporterContact",
      "summary",
      "targetKind",
      "turnstileToken",
    ]);
    const result = await createPublicAbuseReport({
      category: parseAbuseCategory(body.category),
      env,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      ...(body.productSlug === undefined ? {} : { productSlug: body.productSlug }),
      ...(body.reporterContact === undefined ? {} : { reporterContact: body.reporterContact }),
      request,
      requestId: locals.requestId,
      shop,
      summary: body.summary,
      targetKind: parsePublicAbuseTargetKind(body.targetKind),
      ...(body.turnstileToken === undefined ? {} : { turnstileToken: body.turnstileToken }),
    });
    return Response.json({
      ok: true,
      report: result.report,
      requestId: locals.requestId,
    }, {
      status: result.created ? 202 : 200,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
