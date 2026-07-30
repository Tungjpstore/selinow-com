import type { APIRoute } from "astro";

import { CANONICAL_COMMERCE_CONTRACT } from "../../lib/commerce/application";
import { TELEGRAM_CHANNEL_CODE, WEBSITE_CHANNEL_CODE } from "../../lib/channels/builtins";

export const GET: APIRoute = ({ locals }) => {
  return Response.json(
    {
      ok: true,
      service: "selinow.com",
      phase: 6,
      commerce: {
        channels: [TELEGRAM_CHANNEL_CODE, WEBSITE_CHANNEL_CODE],
        contract: CANONICAL_COMMERCE_CONTRACT,
      },
      requestId: locals.requestId,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
};
