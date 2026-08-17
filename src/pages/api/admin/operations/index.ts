import type { APIRoute } from "astro";

import { authenticateRequest } from "../../../../lib/auth/session";
import { createCaughtErrorResponse } from "../../../../lib/http/security";
import {
  listActiveDeadLetters,
  listActiveGeneratedLicenseDeadLetters,
} from "../../../../lib/operations/dead-letters";
import { listActiveDeletionRequests } from "../../../../lib/operations/deletion";
import { listActiveIncidents } from "../../../../lib/operations/incidents";
import { getBindings } from "../../../../lib/platform/bindings";
import { requirePlatformAdminApiAccess } from "../../../../lib/tenants/store";

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    await requirePlatformAdminApiAccess({ env, userId: auth.userId });
    const url = new URL(request.url);
    const deadLettersCursor = url.searchParams.get("deadLettersCursor");
    const deletionsCursor = url.searchParams.get("deletionsCursor");
    const incidentsCursor = url.searchParams.get("incidentsCursor");
    const [deadLetterOverview, generatedLicenseDeadLetterOverview, deletionOverview, incidentOverview] = await Promise.all([
      listActiveDeadLetters({ cursor: deadLettersCursor, env }),
      listActiveGeneratedLicenseDeadLetters({ env }),
      listActiveDeletionRequests({ cursor: deletionsCursor, env, userId: auth.userId }),
      listActiveIncidents({ cursor: incidentsCursor, env }),
    ]);
    return Response.json({
      deadLetters: deadLetterOverview.items,
      deadLettersHasMore: deadLetterOverview.hasMore,
      deadLettersNextCursor: deadLetterOverview.nextCursor ?? null,
      deletionOverview,
      generatedLicenseDeadLetters: generatedLicenseDeadLetterOverview.items,
      generatedLicenseDeadLettersHasMore: generatedLicenseDeadLetterOverview.hasMore,
      incidents: incidentOverview.items,
      incidentsHasMore: incidentOverview.hasMore,
      incidentsNextCursor: incidentOverview.nextCursor ?? null,
      ok: true,
      operationsListLimit: {
        deadLetters: deadLetterOverview.limit,
        generatedLicenseDeadLetters: generatedLicenseDeadLetterOverview.limit,
        incidents: incidentOverview.limit,
      },
      requestId: locals.requestId,
    }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
