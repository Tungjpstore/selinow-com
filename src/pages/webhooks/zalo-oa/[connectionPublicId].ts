import type { APIRoute } from "astro";

import { AppError } from "../../../lib/core/errors";
import { createCaughtErrorResponse } from "../../../lib/http/security";

/**
 * Zalo OA does not currently publish a verifiable webhook signature or
 * challenge contract for this integration. Keep the endpoint explicit and
 * fail closed before consuming the request body until that proof is admitted.
 */
export const POST: APIRoute = ({ locals }) => {
  return createCaughtErrorResponse(
    new AppError("channel_provider_pending", 409, ["zalo.oa"]),
    locals.requestId,
  );
};
