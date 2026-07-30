import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeliveryJobClaim,
  DomainDeliveryQueueEnvelope,
  DomainEventDispatchResult,
} from "../../src/lib/delivery/runtime";
import type { GeneratedLicenseQueueEnvelope } from "../../src/lib/commerce/generated-license";

const NOW = new Date("2026-07-27T12:00:00.000Z");

const dependencies = vi.hoisted(() => ({
  automation: vi.fn(),
  claimDeliveryJobReference: vi.fn(),
  consumeDeadLetterQueue: vi.fn(),
  customDomains: vi.fn(),
  deliverTelegramJob: vi.fn(),
  dispatchDomainEventReference: vi.fn(),
  dispatchDueDomainEvents: vi.fn(),
  enqueueDueDeliveryJobs: vi.fn(),
  enqueueDueGeneratedLicenseRequests: vi.fn(),
  expireOrders: vi.fn(),
  generatedLicenseProviderRegistry: vi.fn(),
  isGeneratedLicenseQueueEnvelope: vi.fn(),
  handle: vi.fn(),
  isDeadLetterQueue: vi.fn(),
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  paymentReconciliation: vi.fn(),
  purgeAdmissions: vi.fn(),
  purgeAnonymousLimits: vi.fn(),
  purgeCartMutationReplays: vi.fn(),
  purgeDataExports: vi.fn(),
  purgeDeliveryGrantClaims: vi.fn(),
  purgeSecurityRateLimits: vi.fn(),
  purgeTelegramUpdates: vi.fn(),
  processGeneratedLicenseRequestReference: vi.fn(),
  recordDeadLetter: vi.fn(),
  sellerWebhookGeneratedLicenseAdapter: vi.fn(),
  settleDeliveryJob: vi.fn(),
  telegramOutbox: vi.fn(),
  terminalStatus: null as string | null,
  terminalAttempts: 3,
  terminalErrorCode: "legacy_delivery_failed",
}));

vi.mock("@astrojs/cloudflare/handler", () => ({ handle: dependencies.handle }));
vi.mock("../../src/lib/auth/admission", () => ({ purgeAuthRequestAdmissions: dependencies.purgeAdmissions }));
vi.mock("../../src/lib/automation/scheduler", () => ({ processScheduledAutomationTasks: dependencies.automation }));
vi.mock("../../src/lib/commerce/cart-mutation", () => ({ purgeCartMutationReplays: dependencies.purgeCartMutationReplays }));
vi.mock("../../src/lib/commerce/generated-license", () => ({
  enqueueDueGeneratedLicenseRequests: dependencies.enqueueDueGeneratedLicenseRequests,
  GeneratedLicenseProviderRegistry: dependencies.generatedLicenseProviderRegistry,
  isGeneratedLicenseQueueEnvelope: dependencies.isGeneratedLicenseQueueEnvelope,
  processGeneratedLicenseRequestReference: dependencies.processGeneratedLicenseRequestReference,
  SellerWebhookGeneratedLicenseAdapter: dependencies.sellerWebhookGeneratedLicenseAdapter,
}));
vi.mock("../../src/lib/commerce/private-file-maintenance", () => ({
  purgeExpiredDeliveryGrantClaims: dependencies.purgeDeliveryGrantClaims,
}));
vi.mock("../../src/lib/commerce/store", () => ({ expireUnpaidOrders: dependencies.expireOrders }));
vi.mock("../../src/lib/delivery/runtime", () => ({
  claimDeliveryJobReference: dependencies.claimDeliveryJobReference,
  dispatchDomainEventReference: dependencies.dispatchDomainEventReference,
  dispatchDueDomainEvents: dependencies.dispatchDueDomainEvents,
  enqueueDueDeliveryJobs: dependencies.enqueueDueDeliveryJobs,
  settleDeliveryJob: dependencies.settleDeliveryJob,
}));
vi.mock("../../src/lib/delivery/telegram", () => ({ deliverTelegramJob: dependencies.deliverTelegramJob }));
vi.mock("../../src/lib/domains/reconciliation", () => ({ reconcileCustomDomains: dependencies.customDomains }));
vi.mock("../../src/lib/operations/dead-letters", () => ({ recordDeadLetter: dependencies.recordDeadLetter }));
vi.mock("../../src/lib/operations/exports", () => ({ purgeExpiredDataExports: dependencies.purgeDataExports }));
vi.mock("../../src/lib/operations/logger", () => ({
  loggerFor: () => ({
    debug: dependencies.loggerDebug,
    error: dependencies.loggerError,
    info: dependencies.loggerInfo,
    warn: dependencies.loggerWarn,
  }),
}));
vi.mock("../../src/lib/operations/queue-dead-letter", () => ({
  consumeDeadLetterQueue: dependencies.consumeDeadLetterQueue,
  isDeadLetterQueue: dependencies.isDeadLetterQueue,
}));
vi.mock("../../src/lib/operations/security-rate-limit-maintenance", () => ({
  purgeExpiredSecurityRateLimits: dependencies.purgeSecurityRateLimits,
}));
vi.mock("../../src/lib/payments/reconciliation", () => ({ reconcilePendingPayments: dependencies.paymentReconciliation }));
vi.mock("../../src/lib/telegram/outbox", () => ({
  processTelegramOutbox: dependencies.telegramOutbox,
  purgeTelegramUpdateHistory: dependencies.purgeTelegramUpdates,
}));
vi.mock("../../src/lib/storefront/abuse", () => ({ purgeAnonymousLimits: dependencies.purgeAnonymousLimits }));

import worker from "../../src/worker";

type TrackedMessage = {
  ack: ReturnType<typeof vi.fn>;
  message: Message;
  retry: ReturnType<typeof vi.fn>;
};

function domainEnvelope(id = "event-worker-001"): DomainDeliveryQueueEnvelope {
  return {
    kind: "integration",
    operationId: "domain_event_dispatch",
    referenceId: id,
    referenceType: "outbox_job",
    requestId: `request-${id}`,
    shopId: "shop-worker-001",
    sourceQueue: "integration",
    version: 1,
  };
}

function deliveryEnvelope(id = "delivery-worker-001"): DomainDeliveryQueueEnvelope {
  return {
    kind: "notification",
    operationId: "channel_delivery",
    referenceId: id,
    referenceType: "outbox_job",
    requestId: `request-${id}`,
    shopId: "shop-worker-001",
    sourceQueue: "notification",
    version: 1,
  };
}

function generatedEnvelope(id = "generated-license-worker-001"): GeneratedLicenseQueueEnvelope {
  return {
    kind: "integration",
    operationId: "generated_license_dispatch",
    referenceId: id,
    referenceType: "generated_license_request",
    requestId: id,
    shopId: "shop-worker-001",
    sourceQueue: "integration",
    version: 1,
  };
}

function deliveryClaim(overrides: Partial<DeliveryJobClaim> = {}): DeliveryJobClaim {
  return {
    attempts: 1,
    connectionId: "connection-worker-001",
    eventId: "event-worker-001",
    id: "delivery-worker-001",
    leaseExpiresAt: "2026-07-27T12:02:00.000Z",
    leaseToken: "lease-worker-001",
    orderId: "order-worker-001",
    providerCode: "telegram",
    purpose: "order.paid",
    queueKind: "notification",
    shopId: "shop-worker-001",
    version: 2,
    ...overrides,
  };
}

function trackedMessage(body: unknown, id: string, attempts = 1): TrackedMessage {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    message: { ack, attempts, body, id, retry, timestamp: NOW },
    retry,
  };
}

function messageBatch(messages: readonly TrackedMessage[], queue = "selinow-notification-staging"): MessageBatch {
  return {
    ackAll: vi.fn(),
    messages: messages.map(({ message }) => message),
    metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
    queue,
    retryAll: vi.fn(),
  };
}

function testDatabase() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(() => dependencies.terminalStatus === null
          ? null
          : {
              attempts: dependencies.terminalAttempts,
              errorCode: dependencies.terminalErrorCode,
              status: dependencies.terminalStatus,
            }),
      })),
    })),
  };
}

function testEnv(): Env {
  const env: Partial<Env> = { APP_ENV: "staging" };
  Object.assign(env, { PLATFORM_DB: testDatabase() });
  return env as Env;
}

function dispatchResult(state: DomainEventDispatchResult["state"]): DomainEventDispatchResult {
  return {
    createdJobs: 0,
    enqueueFailures: 0,
    enqueuedJobs: 0,
    eventId: "event-worker-001",
    state,
  };
}

function loggedMetrics(eventName: string): Record<string, unknown> {
  for (const call of dependencies.loggerInfo.mock.calls as unknown[][]) {
    const event = call[0];
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const fields = event as Record<string, unknown>;
    if (fields.event !== eventName) continue;
    const metrics = fields.metrics;
    if (typeof metrics === "object" && metrics !== null && !Array.isArray(metrics)) {
      return metrics as Record<string, unknown>;
    }
  }
  throw new Error(`Missing structured log event: ${eventName}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dependencies.terminalStatus = null;
  dependencies.terminalAttempts = 3;
  dependencies.terminalErrorCode = "legacy_delivery_failed";
  dependencies.isDeadLetterQueue.mockReturnValue(false);
  dependencies.isGeneratedLicenseQueueEnvelope.mockImplementation((value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    return (value as Record<string, unknown>).operationId === "generated_license_dispatch";
  });
  dependencies.consumeDeadLetterQueue.mockResolvedValue({ persisted: 1, rejected: 0, retried: 0 });
  dependencies.dispatchDomainEventReference.mockResolvedValue(dispatchResult("not_claimed"));
  dependencies.purgeCartMutationReplays.mockResolvedValue(0);
  dependencies.claimDeliveryJobReference.mockResolvedValue(null);
  dependencies.deliverTelegramJob.mockResolvedValue({ kind: "delivered" });
  dependencies.settleDeliveryJob.mockResolvedValue(true);
  dependencies.recordDeadLetter.mockResolvedValue({});
  dependencies.enqueueDueDeliveryJobs.mockResolvedValue({ candidates: 2, failed: 1, sent: 1 });
  dependencies.enqueueDueGeneratedLicenseRequests.mockResolvedValue({ candidates: 4, failed: 1, sent: 3 });
  dependencies.processGeneratedLicenseRequestReference.mockResolvedValue({ state: "not_claimed" });
  dependencies.dispatchDueDomainEvents.mockResolvedValue({
    candidates: 3,
    createdJobs: 1,
    enqueueFailures: 0,
    enqueuedJobs: 1,
    failed: 0,
    notClaimed: 1,
    published: 2,
    retryable: 0,
  });
  dependencies.automation.mockResolvedValue({
    attempted: 1,
    canceled: 0,
    candidates: 1,
    errors: 0,
    failed: 0,
    missingExecutors: 0,
    recovered: 0,
    retryable: 0,
    skipped: 0,
    succeeded: 1,
  });
  dependencies.customDomains.mockResolvedValue({ checked: 1, deleted: 0, failed: 0 });
  dependencies.paymentReconciliation.mockResolvedValue({ failed: 0, processed: 1 });
  dependencies.telegramOutbox.mockResolvedValue({ failed: 0, processed: 1, skipped: 0 });
  dependencies.expireOrders.mockResolvedValue(0);
  dependencies.purgeAdmissions.mockResolvedValue(0);
  dependencies.purgeTelegramUpdates.mockResolvedValue(0);
  dependencies.purgeAnonymousLimits.mockResolvedValue(0);
  dependencies.purgeDataExports.mockResolvedValue({ candidates: 0, deleted: 0, failed: 0, invalidObjectKeys: 0 });
  dependencies.purgeDeliveryGrantClaims.mockResolvedValue(0);
  dependencies.purgeSecurityRateLimits.mockResolvedValue(0);
});

describe("Worker generic domain delivery contract", () => {
  it("keeps the DLQ branch first and bypasses normal queue consumers", async () => {
    dependencies.isDeadLetterQueue.mockReturnValue(true);
    const message = trackedMessage(domainEnvelope(), "message-dlq-001");
    const batch = messageBatch([message], "selinow-dlq-staging");

    await worker.queue(batch, testEnv());

    expect(dependencies.consumeDeadLetterQueue).toHaveBeenCalledOnce();
    expect(dependencies.dispatchDomainEventReference).not.toHaveBeenCalled();
    expect(dependencies.claimDeliveryJobReference).not.toHaveBeenCalled();
  });

  it("processes a mixed batch independently and preserves infrastructure smoke", async () => {
    dependencies.dispatchDomainEventReference.mockResolvedValue(dispatchResult("published"));
    dependencies.claimDeliveryJobReference.mockResolvedValue(deliveryClaim());
    const domain = trackedMessage(domainEnvelope(), "message-domain-001");
    const delivery = trackedMessage(deliveryEnvelope(), "message-delivery-001");
    const smoke = trackedMessage({
      kind: "infrastructure_smoke",
      requestId: "request-smoke-001",
      version: 1,
    }, "message-smoke-001");
    const invalid = trackedMessage({ kind: "notification", payload: "not-reference-only" }, "message-invalid-001");

    await worker.queue(messageBatch([domain, delivery, smoke, invalid]), testEnv());

    expect(domain.ack).toHaveBeenCalledOnce();
    expect(delivery.ack).toHaveBeenCalledOnce();
    expect(smoke.ack).toHaveBeenCalledOnce();
    expect(invalid.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(invalid.ack).not.toHaveBeenCalled();
    expect(dependencies.deliverTelegramJob).toHaveBeenCalledOnce();
    expect(dependencies.settleDeliveryJob).toHaveBeenCalledWith(expect.objectContaining({
      settlement: { status: "delivered" },
    }));
    expect(loggedMetrics("delivery.queue_batch_processed")).toMatchObject({
      acknowledged: 3,
      invalidRetried: 1,
      retried: 1,
    });
  });

  it("ACKs every durable domain-event state and retries only a thrown dispatch", async () => {
    dependencies.dispatchDomainEventReference
      .mockResolvedValueOnce(dispatchResult("published"))
      .mockResolvedValueOnce(dispatchResult("failed"))
      .mockResolvedValueOnce(dispatchResult("retryable"))
      .mockResolvedValueOnce(dispatchResult("not_claimed"))
      .mockRejectedValueOnce(new Error("D1 unavailable"));
    const messages = ["published", "failed", "retryable", "stale", "exception"]
      .map((suffix) => trackedMessage(domainEnvelope(`event-${suffix}-001`), `message-${suffix}-001`));

    await worker.queue(messageBatch(messages, "selinow-integration-staging"), testEnv());

    for (const message of messages.slice(0, 4)) expect(message.ack).toHaveBeenCalledOnce();
    expect(messages[4]?.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(messages[4]?.ack).not.toHaveBeenCalled();
  });

  it("ACKs every durable generated-license state with reference-only service arguments", async () => {
    dependencies.processGeneratedLicenseRequestReference
      .mockResolvedValueOnce({ state: "succeeded" })
      .mockResolvedValueOnce({ state: "retryable" })
      .mockResolvedValueOnce({ state: "reconcile_pending" })
      .mockResolvedValueOnce({ state: "failed" })
      .mockResolvedValueOnce({ state: "not_claimed" });
    const states = ["succeeded", "retryable", "reconcile", "failed", "stale"];
    const messages = states.map((suffix) => trackedMessage(
      generatedEnvelope(`generated-license-${suffix}-001`),
      `message-generated-license-${suffix}-001`,
    ));

    await worker.queue(messageBatch(messages, "selinow-integration-staging"), testEnv());

    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(Object.keys(message.message.body as Record<string, unknown>).sort()).toEqual([
        "kind",
        "operationId",
        "referenceId",
        "referenceType",
        "requestId",
        "shopId",
        "sourceQueue",
        "version",
      ]);
    }
    expect(dependencies.processGeneratedLicenseRequestReference).toHaveBeenCalledTimes(5);
    for (const call of dependencies.processGeneratedLicenseRequestReference.mock.calls) {
      const input = call[0] as Record<string, unknown>;
      expect(Object.keys(input).sort()).toEqual(["env", "now", "registry", "requestId", "shopId"]);
      expect(JSON.stringify({ requestId: input.requestId, shopId: input.shopId })).not.toMatch(
        /credential|artifact|license-value|providerReference/iu,
      );
    }
    expect(loggedMetrics("delivery.queue_batch_processed")).toMatchObject({
      acknowledged: 5,
      generatedLicenseFailed: 1,
      generatedLicenseNotClaimed: 1,
      generatedLicenseReconcilePending: 1,
      generatedLicenseRetryable: 1,
      generatedLicenseSucceeded: 1,
    });
    expect(JSON.stringify(loggedMetrics("delivery.queue_batch_processed"))).not.toMatch(
      /credential|artifact|license-value|providerReference/iu,
    );
  });

  it("retries a thrown generated-license process without ACK", async () => {
    dependencies.processGeneratedLicenseRequestReference.mockRejectedValueOnce(new Error("D1 unavailable"));
    const message = trackedMessage(generatedEnvelope(), "message-generated-license-exception-001");

    await worker.queue(messageBatch([message], "selinow-integration-staging"), testEnv());

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(loggedMetrics("delivery.queue_batch_processed")).toMatchObject({
      acknowledged: 0,
      databaseErrors: 1,
      retried: 1,
    });
  });

  it("ACKs a stale delivery no-op and durably recovers a terminal DLQ record", async () => {
    const stale = trackedMessage(deliveryEnvelope("delivery-stale-001"), "message-stale-001");
    await worker.queue(messageBatch([stale]), testEnv());
    expect(stale.ack).toHaveBeenCalledOnce();
    expect(dependencies.recordDeadLetter).not.toHaveBeenCalled();

    dependencies.terminalStatus = "failed";
    const terminal = trackedMessage(deliveryEnvelope("delivery-terminal-001"), "message-terminal-001", 4);
    await worker.queue(messageBatch([terminal]), testEnv());
    expect(dependencies.recordDeadLetter).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "legacy_delivery_failed",
      messageId: "message-terminal-001",
      providerAttempts: 3,
      queueName: "notification",
      referenceId: "delivery-terminal-001",
      referenceType: "outbox_job",
    }));
    expect(terminal.ack).toHaveBeenCalledOnce();
  });

  it("maps Telegram delivered, retry-after, permanent failure, and exhausted retry", async () => {
    dependencies.claimDeliveryJobReference
      .mockResolvedValueOnce(deliveryClaim({ id: "delivery-ok-001" }))
      .mockResolvedValueOnce(deliveryClaim({ attempts: 2, id: "delivery-retry-001" }))
      .mockResolvedValueOnce(deliveryClaim({ id: "delivery-failed-001" }))
      .mockResolvedValueOnce(deliveryClaim({ attempts: 8, id: "delivery-exhausted-001" }));
    dependencies.deliverTelegramJob
      .mockResolvedValueOnce({ kind: "delivered" })
      .mockResolvedValueOnce({ errorCode: "telegram_rate_limited", kind: "retryable", retryAfterSeconds: 17 })
      .mockResolvedValueOnce({ errorCode: "telegram_recipient_unavailable", kind: "failed" })
      .mockResolvedValueOnce({ errorCode: "provider_unavailable", kind: "retryable" });
    const messages = ["ok", "retry", "failed", "exhausted"].map((suffix) => trackedMessage(
      deliveryEnvelope(`delivery-${suffix}-001`),
      `message-${suffix}-001`,
    ));

    await worker.queue(messageBatch(messages), testEnv());

    expect(dependencies.settleDeliveryJob).toHaveBeenNthCalledWith(1, expect.objectContaining({
      settlement: { status: "delivered" },
    }));
    expect(dependencies.settleDeliveryJob).toHaveBeenNthCalledWith(2, expect.objectContaining({
      settlement: {
        errorCode: "telegram_rate_limited",
        nextAttemptAt: "2026-07-27T12:00:17.000Z",
        status: "retryable",
      },
    }));
    expect(dependencies.settleDeliveryJob).toHaveBeenNthCalledWith(3, expect.objectContaining({
      settlement: { errorCode: "telegram_recipient_unavailable", status: "failed" },
    }));
    expect(dependencies.settleDeliveryJob).toHaveBeenNthCalledWith(4, expect.objectContaining({
      settlement: { errorCode: "provider_unavailable", status: "dead_letter" },
    }));
    expect(dependencies.recordDeadLetter).toHaveBeenCalledTimes(2);
    expect(dependencies.recordDeadLetter).toHaveBeenLastCalledWith(expect.objectContaining({
      failureCode: "provider_unavailable",
      providerAttempts: 8,
      safeEnvelope: {
        operationId: "channel_delivery",
        requestId: "request-delivery-exhausted-001",
      },
    }));
    for (const message of messages) expect(message.ack).toHaveBeenCalledOnce();
  });

  it("settles unknown providers retryably and never invokes the Telegram adapter", async () => {
    dependencies.claimDeliveryJobReference.mockResolvedValue(deliveryClaim({
      attempts: 3,
      providerCode: "whatsapp",
      queueKind: "integration",
    }));
    const message = trackedMessage({
      ...deliveryEnvelope(),
      kind: "integration",
      sourceQueue: "integration",
    }, "message-unknown-provider-001");

    await worker.queue(messageBatch([message]), testEnv());

    expect(dependencies.claimDeliveryJobReference).toHaveBeenCalledWith(expect.objectContaining({
      queueKind: "integration",
    }));
    expect(dependencies.deliverTelegramJob).not.toHaveBeenCalled();
    expect(dependencies.settleDeliveryJob).toHaveBeenCalledWith(expect.objectContaining({
      settlement: {
        errorCode: "delivery_provider_unsupported",
        nextAttemptAt: "2026-07-27T12:02:00.000Z",
        status: "retryable",
      },
    }));
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("retries without ACK when claim, settlement, or terminal recording is not durable", async () => {
    const claimError = trackedMessage(deliveryEnvelope("delivery-claim-error-001"), "message-claim-error-001");
    dependencies.claimDeliveryJobReference.mockRejectedValueOnce(new Error("claim failed"));
    await worker.queue(messageBatch([claimError]), testEnv());
    expect(claimError.retry).toHaveBeenCalledWith({ delaySeconds: 120 });

    const settleError = trackedMessage(deliveryEnvelope("delivery-settle-error-001"), "message-settle-error-001");
    dependencies.claimDeliveryJobReference.mockResolvedValueOnce(deliveryClaim({ id: "delivery-settle-error-001" }));
    dependencies.settleDeliveryJob.mockRejectedValueOnce(new Error("settle failed"));
    await worker.queue(messageBatch([settleError]), testEnv());
    expect(settleError.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(settleError.ack).not.toHaveBeenCalled();

    const recordError = trackedMessage(deliveryEnvelope("delivery-record-error-001"), "message-record-error-001");
    dependencies.claimDeliveryJobReference.mockResolvedValueOnce(deliveryClaim({ id: "delivery-record-error-001" }));
    dependencies.deliverTelegramJob.mockResolvedValueOnce({ errorCode: "telegram_recipient_unavailable", kind: "failed" });
    dependencies.recordDeadLetter.mockRejectedValueOnce(new Error("record failed"));
    await worker.queue(messageBatch([recordError]), testEnv());
    expect(recordError.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(recordError.ack).not.toHaveBeenCalled();
  });

  it("runs generic event/job recovery and the legacy Telegram outbox in cron", async () => {
    dependencies.purgeDataExports.mockResolvedValueOnce({ candidates: 5, deleted: 3, failed: 1, invalidObjectKeys: 1 });
    dependencies.purgeDeliveryGrantClaims.mockResolvedValueOnce(2);
    dependencies.purgeSecurityRateLimits.mockResolvedValueOnce(4);
    const controller: ScheduledController = {
      cron: "*/5 * * * *",
      noRetry: vi.fn(),
      scheduledTime: NOW.getTime(),
    };

    await worker.scheduled(controller, testEnv());

    expect(dependencies.enqueueDueDeliveryJobs).toHaveBeenCalledWith(expect.any(Object), NOW);
    expect(dependencies.enqueueDueGeneratedLicenseRequests).toHaveBeenCalledWith(expect.any(Object), NOW);
    expect(dependencies.dispatchDueDomainEvents).toHaveBeenCalledWith(expect.any(Object), NOW);
    expect(dependencies.telegramOutbox).toHaveBeenCalledWith(expect.any(Object), NOW);
    expect(dependencies.purgeCartMutationReplays).toHaveBeenCalledWith(expect.any(Object), NOW);
    expect(dependencies.purgeDataExports).toHaveBeenCalledWith(expect.any(Object), NOW);
    expect(dependencies.purgeDeliveryGrantClaims).toHaveBeenCalledWith(expect.any(Object), NOW);
    expect(dependencies.purgeSecurityRateLimits).toHaveBeenCalledWith(expect.any(Object), NOW);
    const metrics = loggedMetrics("infrastructure.cron_completed");
    expect(metrics).toMatchObject({
      deliveryJobsCandidates: 2,
      deliveryJobsSent: 1,
      domainEventsCandidates: 3,
      domainEventsPublished: 2,
      generatedLicenseCandidates: 4,
      generatedLicenseEnqueueFailed: 1,
      generatedLicenseEnqueued: 3,
      purgedDataExportCandidates: 5,
      purgedDataExportFailures: 1,
      purgedDataExportInvalidObjectKeys: 1,
      purgedDataExports: 3,
      purgedDeliveryGrantClaims: 2,
      purgedSecurityRateLimits: 4,
      telegramOutboxProcessed: 1,
    });
    expect(Object.values(metrics).every((value) => typeof value === "number")).toBe(true);
  });
});
