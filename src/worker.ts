import { handle } from "@astrojs/cloudflare/handler";

import { processActivationMilestoneBackfill } from "./lib/analytics/activation";
import { purgeAuthRequestAdmissions } from "./lib/auth/admission";
import { processScheduledAutomationTasks } from "./lib/automation/scheduler";
import { expireBillingCheckoutSessions, processDueDodoSubscriptionChanges, suspendExpiredBillingGracePeriods, suspendExpiredTrials } from "./lib/billing/service";
import { purgeCartMutationReplays } from "./lib/commerce/cart-mutation";
import { purgeBuyerOrderRecoveryArtifacts } from "./lib/commerce/buyer-order-recovery";
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
  claimDeliveryProviderAttempt,
  dispatchDomainEventReference,
  dispatchDueDomainEvents,
  enqueueDueDeliveryJobs,
  settleDeliveryJob,
  terminalizeDeliveryProviderOutcomeUnknown,
  type DeliveryJobClaim,
  type DeliveryJobSettlement,
  type DomainDeliveryQueueEnvelope,
  type DomainEventDispatchResult,
  type DeliveryJobTerminalStatus,
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
import { purgeTelegramUpdateHistory } from "./lib/telegram/outbox";
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

type ScheduledJobFailure = {
  errorCode: string;
  job: string;
};

async function runScheduledJob<T>(input: {
  errorCode: string;
  failures: ScheduledJobFailure[];
  fallback: T;
  job: string;
  logger: ReturnType<typeof loggerFor>;
  operation: () => Promise<T>;
  requestId: string;
}): Promise<T> {
  try {
    return await input.operation();
  } catch {
    input.failures.push({ errorCode: input.errorCode, job: input.job });
    input.logger.error({
      errorCode: input.errorCode,
      event: "infrastructure.cron_job_failed",
      queue: input.job,
      requestId: input.requestId,
      source: "scheduled",
    });
    return input.fallback;
  }
}

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
): Promise<DeliveryJobTerminalStatus | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT status, attempts, last_safe_error_code AS errorCode
    FROM delivery_jobs WHERE id = ? AND shop_id = ? AND queue_kind = ? LIMIT 1
  `).bind(envelope.referenceId, envelope.shopId, envelope.kind).first<{
    attempts: number;
    errorCode: string | null;
    status: string;
  }>();
  if (row === null || !new Set(["dead_letter", "delivered", "failed"]).has(row.status)) return null;
  return {
    attempts: row.attempts,
    errorCode: row.errorCode,
    status: row.status as DeliveryJobTerminalStatus["status"],
  };
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

async function acknowledgeTerminalDelivery(input: {
  bindings: AppBindings;
  envelope: DomainDeliveryQueueEnvelope;
  message: Message;
  metrics: QueueMetrics;
  terminal: DeliveryJobTerminalStatus;
}): Promise<void> {
  if (input.terminal.status === "failed" || input.terminal.status === "dead_letter") {
    await recordDeliveryDeadLetter(
      input.bindings,
      input.message,
      input.envelope,
      input.terminal.errorCode ?? (input.terminal.status === "dead_letter"
        ? "delivery_provider_outcome_unknown"
        : "delivery_failed"),
      input.terminal.attempts,
    );
  }
  if (input.terminal.status === "delivered") input.metrics.channelDeliveryDelivered += 1;
  else if (input.terminal.status === "failed") input.metrics.channelDeliveryFailed += 1;
  else input.metrics.channelDeliveryDeadLettered += 1;
  input.message.ack();
  input.metrics.acknowledged += 1;
}

async function recoverDeliverySettlementFailure(input: {
  bindings: AppBindings;
  claim: DeliveryJobClaim;
  envelope: DomainDeliveryQueueEnvelope;
  message: Message;
  metrics: QueueMetrics;
  now: Date;
  providerAttemptClaimed: boolean;
}): Promise<boolean> {
  const terminal = await terminalDeliveryStatus(input.bindings, input.envelope);
  if (terminal !== null) {
    await acknowledgeTerminalDelivery({
      bindings: input.bindings,
      envelope: input.envelope,
      message: input.message,
      metrics: input.metrics,
      terminal,
    });
    return true;
  }
  if (!input.providerAttemptClaimed) return false;

  const unknown = await terminalizeDeliveryProviderOutcomeUnknown({
    claim: input.claim,
    env: input.bindings,
    now: input.now,
    requestId: input.envelope.requestId,
  });
  if (unknown === null) return false;
  await acknowledgeTerminalDelivery({
    bindings: input.bindings,
    envelope: input.envelope,
    message: input.message,
    metrics: input.metrics,
    terminal: unknown,
  });
  return true;
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
          requestId: envelope.requestId,
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
            await acknowledgeTerminalDelivery({
              bindings,
              envelope,
              message,
              metrics,
              terminal: status,
            });
          } else {
            message.ack();
            metrics.acknowledged += 1;
          }
        } catch {
          metrics.databaseErrors += 1;
          retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
        }
        continue;
      }
      metrics.channelDeliveryClaimed += 1;

      let settlementClaim = claim;
      let providerResult: TelegramDeliveryResult;
      if (claim.providerCode === "telegram") {
        try {
          providerResult = await deliverTelegramJob({
            env: bindings,
            job: claim,
            now,
            beforeProviderAttempt: async () => {
              const marked = await claimDeliveryProviderAttempt({
                claim,
                env: bindings,
                now,
                requestId: envelope.requestId,
              });
              if (marked === null) throw new Error("delivery_provider_attempt_not_claimed");
              settlementClaim = marked;
            },
          });
        } catch {
          providerResult = { errorCode: "telegram_delivery_exception", kind: "retryable" };
        }
      } else {
        providerResult = { errorCode: "delivery_provider_unsupported", kind: "retryable" };
        metrics.unsupportedProviders += 1;
      }

      const providerAttemptClaimed = settlementClaim.version !== claim.version;
      const providerOutcomeUnknown = providerAttemptClaimed
        && providerResult.kind === "retryable"
        && providerResult.providerOutcome !== "not_sent";
      if (providerOutcomeUnknown) {
        try {
          const terminal = await terminalizeDeliveryProviderOutcomeUnknown({
            claim: settlementClaim,
            env: bindings,
            now,
            requestId: envelope.requestId,
          });
          if (terminal === null) {
            metrics.databaseErrors += 1;
            retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
            continue;
          }
          await acknowledgeTerminalDelivery({
            bindings,
            envelope,
            message,
            metrics,
            terminal,
          });
        } catch {
          metrics.databaseErrors += 1;
          retryMessage(message, DATABASE_RETRY_DELAY_SECONDS, metrics);
        }
        continue;
      }

      const settlement = deliverySettlement(settlementClaim, providerResult, now);
      try {
        const settled = await settleDeliveryJob({
          claim: settlementClaim,
          database: bindings.PLATFORM_DB,
          now,
          settlement,
        });
        if (!settled) {
          const recovered = await recoverDeliverySettlementFailure({
            bindings,
            claim: settlementClaim,
            envelope,
            message,
            metrics,
            now,
            providerAttemptClaimed,
          });
          if (recovered) continue;
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
            settlementClaim.attempts,
          );
        }
      } catch {
        try {
          const recovered = await recoverDeliverySettlementFailure({
            bindings,
            claim: settlementClaim,
            envelope,
            message,
            metrics,
            now,
            providerAttemptClaimed,
          });
          if (recovered) continue;
        } catch {
          // Retry the queue message when recovery cannot reach durable state.
        }
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
    const scheduledTimeIso = scheduledAt.toISOString();
    const logger = loggerFor(env);
    const requestId = `cron-${String(controller.scheduledTime)}`;
    const failures: ScheduledJobFailure[] = [];
    const run = <T>(
      job: string,
      errorCode: string,
      operation: () => Promise<T>,
      fallback: T,
    ) => runScheduledJob({ errorCode, failures, fallback, job, logger, operation, requestId });

    const deliveryJobs = await run(
      "delivery_jobs",
      "scheduled_delivery_jobs_failed",
      () => enqueueDueDeliveryJobs(bindings, scheduledAt),
      { candidates: 0, failed: 0, sent: 0 },
    );
    const generatedLicenses = await run(
      "generated_licenses",
      "scheduled_generated_licenses_failed",
      () => enqueueDueGeneratedLicenseRequests(bindings, scheduledAt),
      { candidates: 0, failed: 0, sent: 0 },
    );
    const domainEvents = await run(
      "domain_events",
      "scheduled_domain_events_failed",
      () => dispatchDueDomainEvents(bindings, scheduledAt),
      { candidates: 0, createdJobs: 0, enqueueFailures: 0, enqueuedJobs: 0, failed: 0, notClaimed: 0, published: 0, retryable: 0 },
    );
    const automation = await run(
      "automation",
      "scheduled_automation_failed",
      () => processScheduledAutomationTasks(bindings, scheduledAt),
      { attempted: 0, canceled: 0, candidates: 0, errors: 0, failed: 0, missingExecutors: 0, recovered: 0, retryable: 0, skipped: 0, succeeded: 0 },
    );
    const activationBackfill = await run(
      "activation_backfill",
      "scheduled_activation_backfill_failed",
      () => processActivationMilestoneBackfill({ env: bindings, now: scheduledAt, limit: 25 }),
      { attempted: 0, created: 0, failed: 0, shops: 0 },
    );
    const customDomains = await run(
      "custom_domains",
      "scheduled_custom_domains_failed",
      () => reconcileCustomDomains(bindings, scheduledAt),
      { checked: 0, deleted: 0, failed: 0 },
    );
    const reconciliation = await run(
      "payment_reconciliation",
      "scheduled_payment_reconciliation_failed",
      () => reconcilePendingPayments(bindings, scheduledAt),
      { failed: 0, processed: 0 },
    );
    const billingChanges = await run(
      "billing_changes",
      "scheduled_billing_changes_failed",
      () => processDueDodoSubscriptionChanges({ env: bindings, now: scheduledAt }),
      { attempted: 0, candidates: 0, failed: 0, providerPending: 0 },
    );
    const expiredBillingCheckouts = await run(
      "billing_checkout_expiration",
      "scheduled_billing_checkout_expiration_failed",
      () => expireBillingCheckoutSessions({ env: bindings, now: scheduledAt, limit: 100 }),
      0,
    );
    const expiredBillingGracePeriods = await run(
      "billing_grace_period_suspension",
      "scheduled_billing_grace_period_suspension_failed",
      () => suspendExpiredBillingGracePeriods({ env: bindings, now: scheduledAt, limit: 100 }),
      0,
    );
    const expiredBillingTrials = await run(
      "billing_trial_suspension",
      "scheduled_billing_trial_suspension_failed",
      () => suspendExpiredTrials({ env: bindings, now: scheduledAt, limit: 100 }),
      0,
    );
    const expiredOrders = await run(
      "order_expiration",
      "scheduled_order_expiration_failed",
      () => expireUnpaidOrders(bindings, scheduledTimeIso),
      0,
    );
    const expiredGenericEntitlements = await run(
      "generic_entitlement_expiration",
      "scheduled_generic_entitlement_expiration_failed",
      () => expireDueGenericEntitlements({ env: bindings, nowIso: scheduledTimeIso }),
      0,
    );
    const purgedAuthRequestAdmissions = await run(
      "auth_request_admission_purge",
      "scheduled_auth_request_admission_purge_failed",
      () => purgeAuthRequestAdmissions(bindings, scheduledAt),
      0,
    );
    const purgedBuyerOrderRecovery = await run(
      "buyer_order_recovery_purge",
      "scheduled_buyer_order_recovery_purge_failed",
      () => purgeBuyerOrderRecoveryArtifacts({ env: bindings, now: scheduledAt }),
      { deleted: 0, redacted: 0 },
    );
    const purgedCartMutationReplays = await run(
      "cart_mutation_replay_purge",
      "scheduled_cart_mutation_replay_purge_failed",
      () => purgeCartMutationReplays(bindings, scheduledAt),
      0,
    );
    const purgedTelegramUpdates = await run(
      "telegram_update_purge",
      "scheduled_telegram_update_purge_failed",
      () => purgeTelegramUpdateHistory(bindings, scheduledAt),
      0,
    );
    const purgedAnonymousLimits = await run(
      "anonymous_limit_purge",
      "scheduled_anonymous_limit_purge_failed",
      () => purgeAnonymousLimits(bindings, scheduledAt),
      0,
    );
    const purgedDeliveryGrantClaims = await run(
      "delivery_grant_claim_purge",
      "scheduled_delivery_grant_claim_purge_failed",
      () => purgeExpiredDeliveryGrantClaims(bindings, scheduledAt),
      0,
    );
    const purgedSecurityRateLimits = await run(
      "security_rate_limit_purge",
      "scheduled_security_rate_limit_purge_failed",
      () => purgeExpiredSecurityRateLimits(bindings, scheduledAt),
      0,
    );
    const purgedDataExports = await run(
      "data_export_purge",
      "scheduled_data_export_purge_failed",
      () => purgeExpiredDataExports(bindings, scheduledAt),
      { candidates: 0, deleted: 0, failed: 0, invalidObjectKeys: 0 },
    );
    logger.info({
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
        expiredBillingGracePeriods,
        expiredBillingTrials,
        expiredGenericEntitlements,
        paymentReconciliationFailed: reconciliation.failed,
        paymentReconciliationProcessed: reconciliation.processed,
        purgedAuthRequestAdmissions,
        purgedBuyerOrderRecoveryDeleted: purgedBuyerOrderRecovery.deleted,
        purgedBuyerOrderRecoveryRedacted: purgedBuyerOrderRecovery.redacted,
        purgedAnonymousLimits,
        purgedCartMutationReplays,
        purgedDataExportCandidates: purgedDataExports.candidates,
        purgedDataExports: purgedDataExports.deleted,
        purgedDataExportFailures: purgedDataExports.failed,
        purgedDataExportInvalidObjectKeys: purgedDataExports.invalidObjectKeys,
        purgedDeliveryGrantClaims,
        purgedSecurityRateLimits,
        purgedTelegramUpdates,
        scheduledJobFailures: failures.length,
      },
      requestId,
      schedule: controller.cron,
      scheduledTime: controller.scheduledTime,
      source: "scheduled",
    });
  },
} satisfies ExportedHandler<Env>;
