import { handle } from "@astrojs/cloudflare/handler";

import { processActivationMilestoneBackfill } from "./lib/analytics/activation";
import { purgeAuthRequestAdmissions } from "./lib/auth/admission";
import { processScheduledAutomationTasks } from "./lib/automation/scheduler";
import { expireBillingCheckoutSessions, processDueDodoSubscriptionChanges, suspendExpiredTrials } from "./lib/billing/service";
import { purgeCartMutationReplays } from "./lib/commerce/cart-mutation";
import { expireDueGenericEntitlements } from "./lib/commerce/entitlements";
import {
  enqueueDueGeneratedLicenseRequests,
  GeneratedLicenseProviderRegistry,
  isGeneratedLicenseQueueEnvelope,
  processGeneratedLicenseRequestReference,
  SellerWebhookGeneratedLicenseAdapter,
} from "./lib/commerce/generated-license";
import { purgeExpiredDeliveryGrantClaims } from "./lib/commerce/private-file-maintenance";
import { expireUnpaidOrders } from "./lib/commerce/store";
import {
  claimDeliveryJobReference,
  dispatchDomainEventReference,
  dispatchDueDomainEvents,
  enqueueDueDeliveryJobs,
  settleDeliveryJob,
  type DeliveryJobClaim,
  type DeliveryJobSettlement,
  type DomainDeliveryQueueEnvelope,
  type DomainEventDispatchResult,
} from "./lib/delivery/runtime";
import { deliverTelegramJob, type TelegramDeliveryResult } from "./lib/delivery/telegram";
import { reconcileCustomDomains } from "./lib/domains/reconciliation";
import { recordDeadLetter } from "./lib/operations/dead-letters";
import { purgeExpiredDataExports } from "./lib/operations/exports";
import { loggerFor } from "./lib/operations/logger";
import { consumeDeadLetterQueue, isDeadLetterQueue } from "./lib/operations/queue-dead-letter";
import { purgeExpiredSecurityRateLimits } from "./lib/operations/security-rate-limit-maintenance";
import { reconcilePendingPayments } from "./lib/payments/reconciliation";
import type { AppBindings } from "./lib/platform/bindings";
import { processTelegramOutbox, purgeTelegramUpdateHistory } from "./lib/telegram/outbox";
import { purgeAnonymousLimits } from "./lib/storefront/abuse";

const MAX_DELIVERY_ATTEMPTS = 8;
const MAX_RETRY_DELAY_SECONDS = 3_600;
const DATABASE_RETRY_DELAY_SECONDS = 120;
const INVALID_MESSAGE_RETRY_DELAY_SECONDS = 60;
const DELIVERY_BACKOFF_BASE_SECONDS = 30;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const ENVELOPE_FIELDS = new Set([
  "kind",
  "operationId",
  "referenceId",
  "referenceType",
  "requestId",
  "shopId",
  "sourceQueue",
  "version",
]);

type InfrastructureMessage = {
  kind: "infrastructure_smoke";
  requestId: string;
  version: 1;
};

type QueueMetrics = {
  acknowledged: number;
  channelDeliveryClaimed: number;
  channelDeliveryDeadLettered: number;
  channelDeliveryDelivered: number;
  channelDeliveryFailed: number;
  channelDeliveryNotClaimed: number;
  channelDeliveryRetryable: number;
  databaseErrors: number;
  domainEventFailed: number;
  domainEventNotClaimed: number;
  domainEventPublished: number;
  domainEventRetryable: number;
  generatedLicenseFailed: number;
  generatedLicenseNotClaimed: number;
  generatedLicenseReconcilePending: number;
  generatedLicenseRetryable: number;
  generatedLicenseSucceeded: number;
  invalidRetried: number;
  retried: number;
  smokeAcknowledged: number;
  unsupportedProviders: number;
};

type TerminalDelivery = {
  attempts: number;
  errorCode: string | null;
  status: "dead_letter" | "failed";
};

function isInfrastructureMessage(value: unknown): value is InfrastructureMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && candidate.kind === "infrastructure_smoke"
    && typeof candidate.requestId === "string"
    && candidate.requestId.length >= 8
    && candidate.requestId.length <= 128;
}

function isDomainDeliveryQueueEnvelope(value: unknown): value is DomainDeliveryQueueEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const fields = Object.keys(candidate);
  if (fields.length !== ENVELOPE_FIELDS.size || fields.some((key) => !ENVELOPE_FIELDS.has(key))) {
    return false;
  }
  if (candidate.version !== 1 || candidate.referenceType !== "outbox_job") return false;
  if (candidate.kind !== "integration" && candidate.kind !== "notification") return false;
  if (candidate.sourceQueue !== candidate.kind) return false;
  if (candidate.operationId !== "domain_event_dispatch" && candidate.operationId !== "channel_delivery") {
    return false;
  }
  if (candidate.operationId === "domain_event_dispatch" && candidate.kind !== "integration") return false;
  return typeof candidate.referenceId === "string"
    && SAFE_IDENTIFIER.test(candidate.referenceId)
    && typeof candidate.shopId === "string"
    && SAFE_IDENTIFIER.test(candidate.shopId)
    && typeof candidate.requestId === "string"
    && SAFE_REQUEST_ID.test(candidate.requestId);
}

function emptyQueueMetrics(): QueueMetrics {
  return {
    acknowledged: 0,
    channelDeliveryClaimed: 0,
    channelDeliveryDeadLettered: 0,
    channelDeliveryDelivered: 0,
    channelDeliveryFailed: 0,
    channelDeliveryNotClaimed: 0,
    channelDeliveryRetryable: 0,
    databaseErrors: 0,
    domainEventFailed: 0,
    domainEventNotClaimed: 0,
    domainEventPublished: 0,
    domainEventRetryable: 0,
    generatedLicenseFailed: 0,
    generatedLicenseNotClaimed: 0,
    generatedLicenseReconcilePending: 0,
    generatedLicenseRetryable: 0,
    generatedLicenseSucceeded: 0,
    invalidRetried: 0,
    retried: 0,
    smokeAcknowledged: 0,
    unsupportedProviders: 0,
  };
}

function retryMessage(message: Message, delaySeconds: number, metrics: QueueMetrics): void {
  message.retry({ delaySeconds });
  metrics.retried += 1;
}

function recordDomainEventResult(result: DomainEventDispatchResult, metrics: QueueMetrics): void {
  if (result.state === "failed") metrics.domainEventFailed += 1;
  else if (result.state === "not_claimed") metrics.domainEventNotClaimed += 1;
  else if (result.state === "published") metrics.domainEventPublished += 1;
  else metrics.domainEventRetryable += 1;
}

function retryAfterSeconds(claim: DeliveryJobClaim, providerRetryAfterSeconds?: number): number {
  if (typeof providerRetryAfterSeconds === "number"
    && Number.isSafeInteger(providerRetryAfterSeconds)
    && providerRetryAfterSeconds > 0) {
    return Math.min(MAX_RETRY_DELAY_SECONDS, providerRetryAfterSeconds);
  }
  return Math.min(
    MAX_RETRY_DELAY_SECONDS,
    DELIVERY_BACKOFF_BASE_SECONDS * 2 ** Math.min(Math.max(claim.attempts - 1, 0), 7),
  );
}

function deliverySettlement(
  claim: DeliveryJobClaim,
  result: TelegramDeliveryResult,
  now: Date,
): DeliveryJobSettlement {
  if (result.kind === "delivered") return { status: "delivered" };
  if (result.kind === "failed") return { errorCode: result.errorCode, status: "failed" };
  if (claim.attempts >= MAX_DELIVERY_ATTEMPTS) {
    return { errorCode: result.errorCode, status: "dead_letter" };
  }
  return {
    errorCode: result.errorCode,
    nextAttemptAt: new Date(now.getTime() + retryAfterSeconds(claim, result.retryAfterSeconds) * 1_000).toISOString(),
    status: "retryable",
  };
}

async function terminalDeliveryStatus(
  env: AppBindings,
  envelope: DomainDeliveryQueueEnvelope,
): Promise<TerminalDelivery | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT status, attempts, last_safe_error_code AS errorCode
    FROM delivery_jobs WHERE id = ? AND shop_id = ? AND queue_kind = ? LIMIT 1
  `).bind(envelope.referenceId, envelope.shopId, envelope.kind).first<{
    attempts: number;
    errorCode: string | null;
    status: string;
  }>();
  return row?.status === "failed" || row?.status === "dead_letter"
    ? { attempts: row.attempts, errorCode: row.errorCode, status: row.status }
    : null;
}

async function recordDeliveryDeadLetter(
  env: AppBindings,
  message: Message,
  envelope: DomainDeliveryQueueEnvelope,
  failureCode: string,
  providerAttempts: number,
): Promise<void> {
  await recordDeadLetter({
    env,
    failureCode,
    messageId: message.id,
    messageKind: envelope.kind,
    providerAttempts,
    queueName: envelope.sourceQueue,
    referenceId: envelope.referenceId,
    referenceType: "outbox_job",
    safeEnvelope: { operationId: envelope.operationId, requestId: envelope.requestId },
    shopId: envelope.shopId,
  });
}

export default {
  async fetch(request, env, context) {
    return handle(request, env, context);
  },

  async queue(batch, env) {
    const logger = loggerFor(env);
    const bindings = env as unknown as AppBindings;
    if (isDeadLetterQueue(batch.queue, bindings.APP_ENV)) {
      const result = await consumeDeadLetterQueue(batch, bindings);
      logger.info({
        event: "operations.dead_letter_batch_processed",
        metrics: result,
        queue: batch.queue,
        source: "queue",
      });
      return;
    }

    const metrics = emptyQueueMetrics();
    for (const message of batch.messages) {
      if (isInfrastructureMessage(message.body)) {
        message.ack();
        metrics.acknowledged += 1;
        metrics.smokeAcknowledged += 1;
        continue;
      }
      if (isGeneratedLicenseQueueEnvelope(message.body)) {
        try {
          const result = await processGeneratedLicenseRequestReference({
            env: bindings,
            now: new Date(),
            registry: new GeneratedLicenseProviderRegistry([new SellerWebhookGeneratedLicenseAdapter()]),
            requestId: message.body.referenceId,
            shopId: message.body.shopId,
          });
          if (result.state === "failed") metrics.generatedLicenseFailed += 1;
          else if (result.state === "not_claimed") metrics.generatedLicenseNotClaimed += 1;
          else if (result.state === "reconcile_pending") metrics.generatedLicenseReconcilePending += 1;
          else if (result.state === "retryable") metrics.generatedLicenseRetryable += 1;
          else metrics.generatedLicenseSucceeded += 1;
          message.ack();
          metrics.acknowledged += 1;
        } catch {
          metrics.databaseErrors += 1;
          retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
        }
        continue;
      }
      if (!isDomainDeliveryQueueEnvelope(message.body)) {
        metrics.invalidRetried += 1;
        retryMessage(message, INVALID_MESSAGE_RETRY_DELAY_SECONDS, metrics);
        continue;
      }

      const envelope = message.body;
      const now = new Date();
      if (envelope.operationId === "domain_event_dispatch") {
        try {
          const result = await dispatchDomainEventReference({
            env: bindings,
            eventId: envelope.referenceId,
            now,
            shopId: envelope.shopId,
          });
          recordDomainEventResult(result, metrics);
          message.ack();
          metrics.acknowledged += 1;
        } catch {
          metrics.databaseErrors += 1;
          retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
        }
        continue;
      }

      let claim: DeliveryJobClaim | null;
      try {
        claim = await claimDeliveryJobReference({
          env: bindings,
          jobId: envelope.referenceId,
          now,
          queueKind: envelope.kind,
          shopId: envelope.shopId,
        });
      } catch {
        metrics.databaseErrors += 1;
        retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
        continue;
      }
      if (claim === null) {
        metrics.channelDeliveryNotClaimed += 1;
        try {
          const status = await terminalDeliveryStatus(bindings, envelope);
          if (status !== null) {
            await recordDeliveryDeadLetter(
              bindings,
              message,
              envelope,
              status.errorCode ?? (status.status === "dead_letter"
                ? "delivery_attempts_exhausted"
                : "delivery_failed"),
              status.attempts,
            );
          }
          message.ack();
          metrics.acknowledged += 1;
        } catch {
          metrics.databaseErrors += 1;
          retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
        }
        continue;
      }
      metrics.channelDeliveryClaimed += 1;

      let providerResult: TelegramDeliveryResult;
      if (claim.providerCode === "telegram") {
        try {
          providerResult = await deliverTelegramJob({ env: bindings, job: claim, now });
        } catch {
          providerResult = { errorCode: "telegram_delivery_exception", kind: "retryable" };
        }
      } else {
        providerResult = { errorCode: "delivery_provider_unsupported", kind: "retryable" };
        metrics.unsupportedProviders += 1;
      }

      const settlement = deliverySettlement(claim, providerResult, now);
      try {
        const settled = await settleDeliveryJob({
          claim,
          database: bindings.PLATFORM_DB,
          now,
          settlement,
        });
        if (!settled) {
          metrics.databaseErrors += 1;
          retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
          continue;
        }
        if (settlement.status === "failed" || settlement.status === "dead_letter") {
          await recordDeliveryDeadLetter(
            bindings,
            message,
            envelope,
            settlement.errorCode,
            claim.attempts,
          );
        }
      } catch {
        metrics.databaseErrors += 1;
        retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
        continue;
      }

      if (settlement.status === "delivered") metrics.channelDeliveryDelivered += 1;
      else if (settlement.status === "failed") metrics.channelDeliveryFailed += 1;
      else if (settlement.status === "dead_letter") metrics.channelDeliveryDeadLettered += 1;
      else metrics.channelDeliveryRetryable += 1;
      message.ack();
      metrics.acknowledged += 1;
    }

    logger.info({
      event: "delivery.queue_batch_processed",
      metrics,
      queue: batch.queue,
      source: "queue",
    });
  },

  async scheduled(controller, env) {
    const bindings = env as unknown as AppBindings;
    const scheduledAt = new Date(controller.scheduledTime);
    const deliveryJobs = await enqueueDueDeliveryJobs(bindings, scheduledAt);
    const generatedLicenses = await enqueueDueGeneratedLicenseRequests(bindings, scheduledAt);
    const domainEvents = await dispatchDueDomainEvents(bindings, scheduledAt);
    const automation = await processScheduledAutomationTasks(bindings, scheduledAt);
    const activationBackfill = await processActivationMilestoneBackfill({ env: bindings, now: scheduledAt, limit: 25 });
    const customDomains = await reconcileCustomDomains(bindings, scheduledAt);
    const reconciliation = await reconcilePendingPayments(bindings, scheduledAt);
    const billingChanges = await processDueDodoSubscriptionChanges({ env: bindings, now: scheduledAt });
    const expiredBillingCheckouts = await expireBillingCheckoutSessions({ env: bindings, now: scheduledAt, limit: 100 });
    const expiredBillingTrials = await suspendExpiredTrials({ env: bindings, now: scheduledAt, limit: 100 });
    const telegramOutbox = await processTelegramOutbox(bindings, scheduledAt);
    const expiredOrders = await expireUnpaidOrders(bindings, scheduledAt.toISOString());
    const expiredGenericEntitlements = await expireDueGenericEntitlements({ env: bindings, nowIso: scheduledAt.toISOString() });
    const purgedAuthRequestAdmissions = await purgeAuthRequestAdmissions(bindings, scheduledAt);
    const purgedCartMutationReplays = await purgeCartMutationReplays(bindings, scheduledAt);
    const purgedTelegramUpdates = await purgeTelegramUpdateHistory(bindings, scheduledAt);
    const purgedAnonymousLimits = await purgeAnonymousLimits(bindings, scheduledAt);
    const purgedDeliveryGrantClaims = await purgeExpiredDeliveryGrantClaims(bindings, scheduledAt);
    const purgedSecurityRateLimits = await purgeExpiredSecurityRateLimits(bindings, scheduledAt);
    const purgedDataExports = await purgeExpiredDataExports(bindings, scheduledAt);
    loggerFor(env).info({
      event: "infrastructure.cron_completed",
      metrics: {
        automationAttempted: automation.attempted,
        automationCanceled: automation.canceled,
        automationCandidates: automation.candidates,
        automationErrors: automation.errors,
        automationFailed: automation.failed,
        automationMissingExecutors: automation.missingExecutors,
        automationRecovered: automation.recovered,
        automationRetryable: automation.retryable,
        automationSkipped: automation.skipped,
        automationSucceeded: automation.succeeded,
        activationBackfillAttempts: activationBackfill.attempted,
        activationBackfillCreated: activationBackfill.created,
        activationBackfillFailures: activationBackfill.failed,
        activationBackfillShops: activationBackfill.shops,
        billingChangeAttempts: billingChanges.attempted,
        billingChangeCandidates: billingChanges.candidates,
        billingChangeFailures: billingChanges.failed,
        billingChangesProviderPending: billingChanges.providerPending,
        customDomainsChecked: customDomains.checked,
        customDomainsDeleted: customDomains.deleted,
        customDomainsFailed: customDomains.failed,
        deliveryJobsCandidates: deliveryJobs.candidates,
        deliveryJobsFailed: deliveryJobs.failed,
        deliveryJobsSent: deliveryJobs.sent,
        domainEventsCandidates: domainEvents.candidates,
        domainEventsCreatedJobs: domainEvents.createdJobs,
        domainEventsEnqueuedJobs: domainEvents.enqueuedJobs,
        domainEventsFailed: domainEvents.failed,
        domainEventsNotClaimed: domainEvents.notClaimed,
        domainEventsPublished: domainEvents.published,
        domainEventsRetryable: domainEvents.retryable,
        generatedLicenseCandidates: generatedLicenses.candidates,
        generatedLicenseEnqueueFailed: generatedLicenses.failed,
        generatedLicenseEnqueued: generatedLicenses.sent,
        expiredOrders,
        expiredBillingCheckouts,
        expiredBillingTrials,
        expiredGenericEntitlements,
        paymentReconciliationFailed: reconciliation.failed,
        paymentReconciliationProcessed: reconciliation.processed,
        purgedAuthRequestAdmissions,
        purgedAnonymousLimits,
        purgedCartMutationReplays,
        purgedDataExportCandidates: purgedDataExports.candidates,
        purgedDataExports: purgedDataExports.deleted,
        purgedDataExportFailures: purgedDataExports.failed,
        purgedDataExportInvalidObjectKeys: purgedDataExports.invalidObjectKeys,
        purgedDeliveryGrantClaims,
        purgedSecurityRateLimits,
        purgedTelegramUpdates,
        telegramOutboxFailed: telegramOutbox.failed,
        telegramOutboxProcessed: telegramOutbox.processed,
        telegramOutboxSkipped: telegramOutbox.skipped,
      },
      schedule: controller.cron,
      scheduledTime: controller.scheduledTime,
      source: "scheduled",
    });
  },
} satisfies ExportedHandler<Env>;
