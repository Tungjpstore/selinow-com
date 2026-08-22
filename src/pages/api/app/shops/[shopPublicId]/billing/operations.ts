import type { APIRoute } from "astro";

import { authenticateRequest, requireCsrfSession, requireRecentAuth } from "../../../../../../lib/auth/session";
import { executeDodoSubscriptionChangeRequest } from "../../../../../../lib/billing/service";
import { requireResourceId } from "../../../../../../lib/catalog/policy";
import { AppError } from "../../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../../lib/http/security";
import { getBindings } from "../../../../../../lib/platform/bindings";
import { getSellerBilling } from "../../../../../../lib/tenants/seller-management";
import { createSubscriptionChangeRequest, listSubscriptionChangeRequests, type SubscriptionChangeRequest } from "../../../../../../lib/tenants/billing-requests";
import { getShopForMember } from "../../../../../../lib/tenants/store";

const OPERATION_ID = /^[A-Za-z0-9._:-]{3,160}$/u;

function projectOperation(request: SubscriptionChangeRequest | undefined): {
  action: SubscriptionChangeRequest["action"];
  operationId: string;
  requestedPlanCode: string | null;
  status: SubscriptionChangeRequest["status"];
} | null {
  if (request === undefined) return null;
  return {
    action: request.action,
    operationId: request.requestPublicId,
    requestedPlanCode: request.requestedPlanCode,
    status: request.status,
  };
}

export const GET: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await authenticateRequest(request, env);
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    const operationId = new URL(request.url).searchParams.get("operation");
    if (operationId !== null && !OPERATION_ID.test(operationId)) throw new AppError("validation_failed", 400, ["operation_id_invalid"]);
    const [billing, requests] = await Promise.all([
      getSellerBilling({ env, shopPublicId, userId: auth.userId }),
      listSubscriptionChangeRequests({ env, shopPublicId, userId: auth.userId }),
    ]);
    const operation = operationId === null
      ? requests.find((item) => item.status === "requested" || item.status === "provider_pending") ?? requests[0]
      : requests.find((item) => item.requestPublicId === operationId);
    return Response.json({
      ok: true,
      operation: projectOperation(operation),
      requestId: locals.requestId,
      subscription: {
        currentPeriodEnd: billing.currentPeriodEnd,
        planCode: billing.planCode,
        scheduledEffectiveAt: billing.scheduledEffectiveAt,
        scheduledPlanCode: billing.scheduledPlanCode,
        scheduledPlanName: billing.scheduledPlanName,
        state: billing.state,
        version: billing.subscriptionVersion,
      },
    }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  try {
    const env = getBindings();
    const auth = await requireCsrfSession(request, env);
    requireRecentAuth(auth);
    const shopPublicId = requireResourceId(params.shopPublicId, "shop");
    const body = await readJsonObject(request, 8 * 1024);
    rejectUnknownFields(body, ["action", "expectedSubscriptionVersion", "requestedPlanCode"]);
    if (body.action !== "cancel" && body.action !== "cancel_scheduled_plan_change" && body.action !== "change_plan" && body.action !== "resume") throw new AppError("validation_failed", 400, ["billing_action_invalid"]);
    const actor = await getShopForMember({ capability: "billing:manage", env, shopPublicId, userId: auth.userId });
    const operation = await createSubscriptionChangeRequest({
      action: body.action,
      env,
      expectedSubscriptionVersion: body.expectedSubscriptionVersion as number,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      ...(body.action === "change_plan" ? { requestedPlanCode: body.requestedPlanCode } : {}),
      reasonCode: "seller_requested",
      requestId: locals.requestId,
      shopPublicId,
      userId: auth.userId,
    });

    let executionStatus = operation.status;
    let retryScheduled = false;
    try {
      const executed = await executeDodoSubscriptionChangeRequest({
        env,
        fetcher: fetch,
        requestId: locals.requestId,
        requestPublicId: operation.requestPublicId,
        reviewedByUserId: auth.userId,
        shopId: actor.row.shop_id,
      });
      executionStatus = executed.status as SubscriptionChangeRequest["status"];
    } catch (error) {
      // The durable request remains queued for the scheduled worker. The seller
      // receives an accepted operation instead of being asked to submit again.
      if (!(error instanceof AppError) || !["billing_provider_unavailable", "billing_provider_operation_unavailable", "provider_not_ready"].includes(error.code)) throw error;
      retryScheduled = true;
    }

    return Response.json({
      ok: true,
      operation: {
        action: operation.action,
        operationId: operation.requestPublicId,
        requestedPlanCode: operation.requestedPlanCode,
        status: executionStatus,
      },
      requestId: locals.requestId,
      retryScheduled,
    }, { headers: PRIVATE_RESPONSE_HEADERS, status: 202 });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
