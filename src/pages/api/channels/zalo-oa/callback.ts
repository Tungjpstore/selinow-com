import type { APIRoute } from "astro";

import { readJsonObject, rejectUnknownFields } from "../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../lib/http/security";
import { getBindings } from "../../../../lib/platform/bindings";
import { completeZaloOfficialAccountOAuth } from "../../../../lib/channels/zalo-oa-oauth-routes";
import { AppError } from "../../../../lib/core/errors";

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const body = await readJsonObject(request, 12 * 1024);
    rejectUnknownFields(body, ["code", "oa_id", "state"]);
    const result = await completeZaloOfficialAccountOAuth({
      authorizationCode: body.code,
      env: getBindings(),
      officialAccountId: body.oa_id,
      receivedState: body.state,
    });
    return Response.json({ ok: true, result, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
      status: 201,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

function readSingleQueryParam(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new AppError("validation_failed", 400, [`duplicate_query_field:${name}`]);
  }
  return values[0];
}

/**
 * Zalo redirects the OA administrator's browser to the callback with a GET
 * query (`code`, `oa_id`, and the caller's `state`). Keep this transport
 * contract explicit even while the provider admission gate remains closed.
 */
export const GET: APIRoute = async ({ locals, request }) => {
  try {
    if (request.url.length > 12 * 1024) {
      throw new AppError("validation_failed", 413, ["request_url_too_large"]);
    }
    const url = new URL(request.url);
    const query: Record<string, unknown> = {
      code: readSingleQueryParam(url, "code"),
      oa_id: readSingleQueryParam(url, "oa_id"),
      state: readSingleQueryParam(url, "state"),
    };
    rejectUnknownFields(Object.fromEntries(url.searchParams.keys().map((key) => [key, query[key]])), ["code", "oa_id", "state", "error", "error_description"]);
    const result = await completeZaloOfficialAccountOAuth({
      authorizationCode: query.code,
      env: getBindings(),
      officialAccountId: query.oa_id,
      receivedState: query.state,
    });
    return Response.json({ ok: true, result, requestId: locals.requestId }, {
      headers: PRIVATE_RESPONSE_HEADERS,
      status: 201,
    });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
