import type { APIRoute } from "astro";

import { requireCsrfSession } from "../../../../../../lib/auth/session";
import { parseProductInput, parseProductWithInitialVariantInput } from "../../../../../../lib/catalog/http";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { createProduct, createProductWithInitialVariant } from "../../../../../../lib/catalog/store";
import { readJsonObject } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    const body = await readJsonObject(request);
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    if (Object.hasOwn(body, "initialVariant")) {
      const parsed = parseProductWithInitialVariantInput(body);
      const result = await createProductWithInitialVariant({
        data: parsed.product,
        env,
        idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
        initialVariant: parsed.variant,
        requestId: locals.requestId,
        shopPublicId,
        userId: auth.userId,
      });
      return Response.json({ ok: true, product: result.product, requestId: locals.requestId, variant: result.variant }, {
        status: result.created ? 201 : 200,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }
    const product = await createProduct({ data: parseProductInput(body), env, shopPublicId, userId: auth.userId });
    return Response.json({ ok: true, product, requestId: locals.requestId }, { status: 201, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return createCaughtErrorResponse(error, locals.requestId); }
};
