import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../lib/auth/session";
import { AppError } from "../../../../lib/core/errors";
import { encodeCreatedIdCursor } from "../../../../lib/core/pagination";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { listAdminPaymentRemediationRequests } from "../../../../lib/payments/remediation";
import { requirePlatformAdminApiAccess } from "../../../../lib/tenants/store";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 100;
// The remediation service caps a single fetch at 100 rows, so a `limit + 1`
// over-fetch is only possible below the cap; at the cap we probe one row
// past the page instead to keep hasMore exact.
const SERVICE_FETCH_CAP = 100;

function parsePageLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_PAGE_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
    throw new AppError("validation_failed", 400, ["limit_invalid"]);
  }
  return parsed;
}

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    await requirePlatformAdminApiAccess({ env, userId: auth.userId });
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    if (status !== null && status !== "" && !/^[a-z_]{3,32}$/u.test(status)) {
      throw new AppError("validation_failed", 400, ["status_invalid"]);
    }
    const cursor = url.searchParams.get("cursor");
    const pageLimit = parsePageLimit(url.searchParams.get("limit"));
    // Fetch one extra row to detect hasMore accurately while the service keeps
    // returning a plain array (backward compatible with the appeals page).
    const fetchLimit = Math.min(pageLimit + 1, SERVICE_FETCH_CAP);
    const fetched = await listAdminPaymentRemediationRequests({
      cursor,
      env,
      limit: fetchLimit,
      status,
      userId: auth.userId,
    });
    let hasMore = fetched.length > pageLimit;
    const requests = hasMore ? fetched.slice(0, pageLimit) : fetched;
    if (!hasMore && fetched.length === SERVICE_FETCH_CAP) {
      // The service cap consumed the over-fetch slot; probe one row past the
      // last returned row so the boundary (exactly `limit` rows remain) stays exact.
      const probeAnchor = fetched.at(-1);
      if (probeAnchor !== undefined) {
        const probe = await listAdminPaymentRemediationRequests({
          cursor: encodeCreatedIdCursor({ createdAt: probeAnchor.createdAt, id: probeAnchor.id }),
          env,
          limit: 1,
          status,
          userId: auth.userId,
        });
        hasMore = probe.length > 0;
      }
    }
    const last = requests.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeCreatedIdCursor({ createdAt: last.createdAt, id: last.id })
      : null;
    return Response.json({
      hasMore,
      nextCursor,
      ok: true,
      requestId: locals.requestId,
      requests,
    }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
