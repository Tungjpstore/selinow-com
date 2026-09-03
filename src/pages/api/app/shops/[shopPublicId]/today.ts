import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../lib/catalog/policy";
import { getSellerTodaySnapshot } from "../../../../../lib/dashboard/today-snapshot";
import { createCaughtErrorResponse } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";

async function etagOf(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return `"today-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}"`;
}

/**
 * EX3.2 — the Today cockpit read model. Conditional-GET enabled (ETag +
 * must-revalidate) so the EX freshness poller revalidates cheaply; the body
 * carries no secrets beyond what the overview page already renders.
 */
export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const snapshot = await getSellerTodaySnapshot({
      env,
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      userId: auth.userId,
    });
    // The validator covers the snapshot only: requestId rotates per request
    // and must never break conditional revalidation for the poller.
    const body = JSON.stringify({ ok: true, requestId: locals.requestId, snapshot });
    const etag = await etagOf(JSON.stringify(snapshot));
    if (request.headers.get("If-None-Match") === etag) {
      return new Response(null, { headers: { "Cache-Control": "private, max-age=0, must-revalidate", ETag: etag }, status: 304 });
    }
    return new Response(body, {
      headers: { "Cache-Control": "private, max-age=0, must-revalidate", "Content-Type": "application/json", ETag: etag },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
