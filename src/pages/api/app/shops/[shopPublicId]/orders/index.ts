import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../../../lib/auth/session";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { listSellerOrdersPage, parseSellerOrderSort, parseSellerOrderStatusFilter } from "../../../../../../lib/commerce/seller-orders";
import { createCaughtErrorResponse } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const url = new URL(request.url);
    // EX3.7: expose the same URL table contract the SSR page uses
    // (q/status/sort/page/pageSize) so record workspaces and the command
    // palette can query orders client-side without new lib surface.
    const rawLimit = url.searchParams.get("limit");
    const parsedPage = Number.parseInt(url.searchParams.get("page") ?? "", 10);
    const parsedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "", 10);
    const search = url.searchParams.get("q");
    const page = await listSellerOrdersPage({
      cursor: url.searchParams.get("cursor"),
      env,
      ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
      ...(parsedPage >= 1 ? { page: parsedPage } : {}),
      ...(parsedPageSize >= 1 && parsedPageSize <= 100 ? { pageSize: parsedPageSize } : {}),
      ...(search === null ? {} : { search }),
      shopPublicId: requireResourceId(params.shopPublicId, "shop"),
      sort: parseSellerOrderSort(url.searchParams.get("sort")),
      statusFilter: parseSellerOrderStatusFilter(url.searchParams.get("status")),
      userId: auth.userId,
    });
    return Response.json({ nextCursor: page.nextCursor, ok: true, orders: page.orders, requestId: locals.requestId }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
