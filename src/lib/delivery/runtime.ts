import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { sha256Hex } from "../events/append";

const DOMAIN_EVENT_LEASE_MS = 60_000;
const DELIVERY_JOB_LEASE_MS = 120_000;
const MAX_BATCH_SIZE = 50;
const MAX_EVENT_ATTEMPTS = 8;
const ORDER_PAID_EVENT_TYPE = "order.paid";
const ORDER_PAID_PURPOSE = "order.paid";
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_CODE = /^[a-z][a-z0-9._:-]{2,95}$/u;

type QueueKind = "integration" | "notification";
type DomainEventStatus = "pending" | "processing" | "retryable";
type DeliveryJobStatus = "pending" | "processing" | "retryable";

export type DomainDeliveryQueueEnvelope = {
  kind: QueueKind;
  operationId: "channel_delivery" | "domain_event_dispatch";
  referenceId: string;
  referenceType: "outbox_job";
  requestId: string;
  shopId: string;
  sourceQueue: QueueKind;
  version: 1;
};

export type DomainEventClaim = {
  aggregateId: string;
  aggregateType: string;
  attempts: number;
  eventType: string;
  id: string;
  leaseExpiresAt: string;
  leaseToken: string;
  schemaVersion: number;
  shopId: string;
  version: number;
};

export type DeliveryJobClaim = {
  attempts: number;
  connectionId: string;
  eventId: string;
  id: string;
  leaseExpiresAt: string;
  leaseToken: string;
  orderId: string;
  providerCode: string;
  purpose: string;
  queueKind: QueueKind;
  shopId: string;
  version: number;
};

export type DomainEventDispatchResult = {
  createdJobs: number;
  enqueueFailures: number;
  enqueuedJobs: number;
  eventId: string;
  state: "failed" | "not_claimed" | "published" | "retryable";
};

export type DomainEventDispatchBatchResult = {
  candidates: number;
  createdJobs: number;
  enqueueFailures: number;
  enqueuedJobs: number;
  failed: number;
  notClaimed: number;
  published: number;
  retryable: number;
};

export type DeliveryJobEnqueueResult = {
  candidates: number;
  failed: number;
  sent: number;
};

export type DeliveryJobSettlement =
  | { status: "delivered" }
  | { errorCode: string; nextAttemptAt: string; status: "retryable" }
  | { errorCode: string; status: "dead_letter" | "failed" };

type DueDomainEvent = {
  id: string;
  shopId: string;
  status: DomainEventStatus;
  version: number;
};

type DueDeliveryJob = {
  id: string;
  queueKind: QueueKind;
  shopId: string;
  status: DeliveryJobStatus;
  version: number;
};

type ClaimedEventRoute = {
  attributionExists: number;
  connectionId: string | null;
  connectionStatus: string | null;
  grantActive: number;
  orderPaid: number;
  providerCode: string | null;
  shopChannelStatus: string | null;
  shopStatus: string;
};

type DeliveryJobReference = {
  id: string;
  queueKind: QueueKind;
  shopId: string;
};

function runtimeError(issue: string): AppError {
  return new AppError("domain_delivery_runtime_invalid", 400, [issue]);
}

function assertIdentifier(value: string, issue: string): void {
  if (!SAFE_IDENTIFIER.test(value)) throw runtimeError(issue);
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw runtimeError("version_invalid");
}

function assertIsoTimestamp(value: string, issue: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw runtimeError(issue);
  }
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw runtimeError("limit_invalid");
  }
}

function assertSafeCode(value: string): void {
  if (!SAFE_CODE.test(value)) throw runtimeError("safe_error_code_invalid");
}

function changes(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0;
}

function createQueueEnvelope(input: {
  operationId: DomainDeliveryQueueEnvelope["operationId"];
  queueKind: QueueKind;
  referenceId: string;
  shopId: string;
}): DomainDeliveryQueueEnvelope {
  return {
    kind: input.queueKind,
    operationId: input.operationId,
    referenceId: input.referenceId,
    referenceType: "outbox_job",
    requestId: createId("qreq"),
    shopId: input.shopId,
    sourceQueue: input.queueKind,
    version: 1,
  };
}

function queueFor(env: AppBindings, kind: QueueKind): Queue {
  return kind === "integration" ? env.INTEGRATION_QUEUE : env.NOTIFICATION_QUEUE;
}

async function listDueDomainEvents(
  database: D1Database,
  nowIso: string,
  limit: number,
  shopId: string | null,
): Promise<DueDomainEvent[]> {
  const result = await database.prepare(`
    SELECT id, shop_id AS shopId, status, version
    FROM domain_events
    WHERE (? IS NULL OR shop_id = ?)
      AND (
        (status IN ('pending', 'retryable') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_expires_at <= ?)
      )
    ORDER BY COALESCE(next_attempt_at, lease_expires_at), id
    LIMIT ?
  `).bind(shopId, shopId, nowIso, nowIso, limit).all<DueDomainEvent>();
  return result.results;
}

export async function claimDomainEvent(input: {
  database: D1Database;
  eventId: string;
  expectedVersion: number;
  now: Date;
  shopId: string;
}): Promise<DomainEventClaim | null> {
  assertIdentifier(input.eventId, "event_id_invalid");
  assertIdentifier(input.shopId, "shop_id_invalid");
  assertVersion(input.expectedVersion);
  const nowIso = input.now.toISOString();
  const leaseToken = createOpaqueToken(18);
  const leaseExpiresAt = new Date(input.now.getTime() + DOMAIN_EVENT_LEASE_MS).toISOString();
  const claimed = await input.database.prepare(`
    UPDATE domain_events
    SET status = 'processing', attempts = attempts + 1, next_attempt_at = NULL,
      lease_token = ?, lease_expires_at = ?, last_safe_error_code = NULL,
      version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND version = ?
      AND (
        (status IN ('pending', 'retryable') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_expires_at <= ?)
      )
  `).bind(
    leaseToken,
    leaseExpiresAt,
    nowIso,
    input.eventId,
    input.shopId,
    input.expectedVersion,
    nowIso,
    nowIso,
  ).run();
  if (changes(claimed) !== 1) return null;
  return input.database.prepare(`
    SELECT id, shop_id AS shopId, event_type AS eventType,
      aggregate_type AS aggregateType, aggregate_id AS aggregateId,
      schema_version AS schemaVersion, attempts, lease_token AS leaseToken,
      lease_expires_at AS leaseExpiresAt, version
    FROM domain_events
    WHERE id = ? AND shop_id = ? AND status = 'processing'
      AND lease_token = ? AND version = ?
    LIMIT 1
  `).bind(
    input.eventId,
    input.shopId,
    leaseToken,
    input.expectedVersion + 1,
  ).first<DomainEventClaim>();
}

async function loadClaimedEventRoute(
  database: D1Database,
  claim: DomainEventClaim,
  nowIso: string,
): Promise<ClaimedEventRoute | null> {
  return database.prepare(`
    SELECT shops.status AS shopStatus,
      CASE WHEN attribution.order_id IS NULL THEN 0 ELSE 1 END AS attributionExists,
      attribution.connection_id AS connectionId,
      connection.status AS connectionStatus,
      connection.provider_code AS providerCode,
      shop_channel.status AS shopChannelStatus,
      CASE WHEN EXISTS (
        SELECT 1 FROM channel_connection_grants AS grant_row
        WHERE grant_row.shop_id = event.shop_id
          AND grant_row.connection_id = attribution.connection_id
          AND grant_row.capability_code = 'conversation.outbound'
          AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
      ) THEN 1 ELSE 0 END AS grantActive,
      CASE WHEN EXISTS (
        SELECT 1 FROM orders
        WHERE orders.shop_id = event.shop_id
          AND orders.id = event.aggregate_id
          AND orders.payment_status = 'paid'
      ) THEN 1 ELSE 0 END AS orderPaid
    FROM domain_events AS event
    INNER JOIN shops ON shops.id = event.shop_id
    LEFT JOIN order_channel_attributions AS attribution
      ON attribution.shop_id = event.shop_id
      AND attribution.order_id = event.aggregate_id
    LEFT JOIN channel_connections AS connection
      ON connection.shop_id = event.shop_id
      AND connection.id = attribution.connection_id
    LEFT JOIN shop_channels AS shop_channel
      ON shop_channel.shop_id = connection.shop_id
      AND shop_channel.id = connection.shop_channel_id
    WHERE event.id = ? AND event.shop_id = ? AND event.status = 'processing'
      AND event.lease_token = ? AND event.version = ?
      AND event.lease_expires_at > ?
    LIMIT 1
  `).bind(
    nowIso,
    claim.id,
    claim.shopId,
    claim.leaseToken,
    claim.version,
    nowIso,
  ).first<ClaimedEventRoute>();
}

async function settleDomainEvent(input: {
  claim: DomainEventClaim;
  database: D1Database;
  errorCode: string | null;
  nextAttemptAt: string | null;
  nowIso: string;
  status: "failed" | "published" | "retryable";
}): Promise<boolean> {
  if (input.errorCode !== null) assertSafeCode(input.errorCode);
  if (input.nextAttemptAt !== null) assertIsoTimestamp(input.nextAttemptAt, "next_attempt_at_invalid");
  const publishedAt = input.status === "published" ? input.nowIso : null;
  const result = await input.database.prepare(`
    UPDATE domain_events
    SET status = ?, next_attempt_at = ?, lease_token = NULL,
      lease_expires_at = NULL, last_safe_error_code = ?, published_at = ?,
      version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND status = 'processing'
      AND lease_token = ? AND lease_expires_at > ? AND version = ?
  `).bind(
    input.status,
    input.nextAttemptAt,
    input.errorCode,
    publishedAt,
    input.nowIso,
    input.claim.id,
    input.claim.shopId,
    input.claim.leaseToken,
    input.nowIso,
    input.claim.version,
  ).run();
  return changes(result) === 1;
}

function retryAtForEvent(claim: DomainEventClaim, now: Date): string {
  const seconds = Math.min(3_600, 15 * 2 ** Math.min(claim.attempts, 8));
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

async function failClaimedEvent(
  database: D1Database,
  claim: DomainEventClaim,
  nowIso: string,
  errorCode: string,
): Promise<DomainEventDispatchResult> {
  const settled = await settleDomainEvent({
    claim,
    database,
    errorCode,
    nextAttemptAt: null,
    nowIso,
    status: "failed",
  });
  return {
    createdJobs: 0,
    enqueueFailures: 0,
    enqueuedJobs: 0,
    eventId: claim.id,
    state: settled ? "failed" : "not_claimed",
  };
}

async function retryClaimedEvent(
  database: D1Database,
  claim: DomainEventClaim,
  now: Date,
  errorCode: string,
): Promise<DomainEventDispatchResult> {
  if (claim.attempts >= MAX_EVENT_ATTEMPTS) {
    return failClaimedEvent(database, claim, now.toISOString(), errorCode);
  }
  const settled = await settleDomainEvent({
    claim,
    database,
    errorCode,
    nextAttemptAt: retryAtForEvent(claim, now),
    nowIso: now.toISOString(),
    status: "retryable",
  });
  return {
    createdJobs: 0,
    enqueueFailures: 0,
    enqueuedJobs: 0,
    eventId: claim.id,
    state: settled ? "retryable" : "not_claimed",
  };
}

async function publishEventWithoutDelivery(
  database: D1Database,
  claim: DomainEventClaim,
  nowIso: string,
): Promise<DomainEventDispatchResult> {
  const published = await database.prepare(`
    UPDATE domain_events
    SET status = 'published', next_attempt_at = NULL, lease_token = NULL,
      lease_expires_at = NULL, last_safe_error_code = NULL, published_at = ?,
      version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND status = 'processing'
      AND lease_token = ? AND lease_expires_at > ? AND version = ?
      AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND status = 'active')
      AND EXISTS (
        SELECT 1 FROM order_channel_attributions
        WHERE shop_id = ? AND order_id = ? AND connection_id IS NULL
      )
  `).bind(
    nowIso,
    nowIso,
    claim.id,
    claim.shopId,
    claim.leaseToken,
    nowIso,
    claim.version,
    claim.shopId,
    claim.shopId,
    claim.aggregateId,
  ).run();
  return {
    createdJobs: 0,
    enqueueFailures: 0,
    enqueuedJobs: 0,
    eventId: claim.id,
    state: changes(published) === 1 ? "published" : "not_claimed",
  };
}

async function publishUnsubscribedEvent(
  database: D1Database,
  claim: DomainEventClaim,
  nowIso: string,
): Promise<DomainEventDispatchResult> {
  const settled = await settleDomainEvent({
    claim,
    database,
    errorCode: null,
    nextAttemptAt: null,
    nowIso,
    status: "published",
  });
  return {
    createdJobs: 0,
    enqueueFailures: 0,
    enqueuedJobs: 0,
    eventId: claim.id,
    state: settled ? "published" : "not_claimed",
  };
}

async function enqueueDeliveryJob(
  env: AppBindings,
  job: DeliveryJobReference,
  nowIso: string,
): Promise<boolean> {
  try {
    const eligibleJob = await env.PLATFORM_DB.prepare(`
      SELECT 1 AS eligible
      FROM delivery_jobs AS delivery_job
      INNER JOIN domain_events AS event
        ON event.shop_id = delivery_job.shop_id
        AND event.id = delivery_job.event_id
        AND event.status = 'published'
        AND event.event_type = 'order.paid'
        AND event.schema_version = 1
      INNER JOIN shops
        ON shops.id = delivery_job.shop_id
        AND shops.status = 'active'
      INNER JOIN channel_connections AS connection
        ON connection.shop_id = delivery_job.shop_id
        AND connection.id = delivery_job.connection_id
        AND connection.status IN ('active', 'degraded')
      INNER JOIN shop_channels AS shop_channel
        ON shop_channel.shop_id = connection.shop_id
        AND shop_channel.id = connection.shop_channel_id
        AND shop_channel.status = 'enabled'
      INNER JOIN channel_connection_grants AS grant_row
        ON grant_row.shop_id = connection.shop_id
        AND grant_row.connection_id = connection.id
        AND grant_row.capability_code = 'conversation.outbound'
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
      WHERE delivery_job.id = ? AND delivery_job.shop_id = ?
        AND delivery_job.queue_kind = ?
        AND delivery_job.purpose = 'order.paid'
        AND (
          (delivery_job.status IN ('pending', 'retryable') AND delivery_job.next_attempt_at <= ?)
          OR (delivery_job.status = 'processing' AND delivery_job.lease_expires_at <= ?)
        )
      LIMIT 1
    `).bind(
      nowIso,
      job.id,
      job.shopId,
      job.queueKind,
      nowIso,
      nowIso,
    ).first<{ eligible: number }>();
    if (eligibleJob === null) return false;
    await queueFor(env, job.queueKind).send(createQueueEnvelope({
      operationId: "channel_delivery",
      queueKind: job.queueKind,
      referenceId: job.id,
      shopId: job.shopId,
    }));
    return true;
  } catch {
    return false;
  }
}

async function publishEventWithDelivery(
  env: AppBindings,
  claim: DomainEventClaim,
  connectionId: string,
  nowIso: string,
): Promise<DomainEventDispatchResult> {
  const idempotencyHash = await sha256Hex(
    `${claim.shopId}\0${claim.id}\0${connectionId}\0${ORDER_PAID_PURPOSE}`,
  );
  const jobId = `dlj_${idempotencyHash.slice(0, 40)}`;
  const results = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`
      UPDATE domain_events
      SET status = 'published', next_attempt_at = NULL, lease_token = NULL,
        lease_expires_at = NULL, last_safe_error_code = NULL, published_at = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND status = 'processing'
        AND lease_token = ? AND lease_expires_at > ? AND version = ?
        AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND status = 'active')
        AND EXISTS (
          SELECT 1
          FROM order_channel_attributions AS attribution
          INNER JOIN channel_connections AS connection
            ON connection.shop_id = attribution.shop_id
            AND connection.id = attribution.connection_id
            AND connection.status IN ('active', 'degraded')
          INNER JOIN shop_channels AS shop_channel
            ON shop_channel.shop_id = connection.shop_id
            AND shop_channel.id = connection.shop_channel_id
            AND shop_channel.status = 'enabled'
          INNER JOIN channel_connection_grants AS grant_row
            ON grant_row.shop_id = connection.shop_id
            AND grant_row.connection_id = connection.id
            AND grant_row.capability_code = 'conversation.outbound'
            AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
          WHERE attribution.shop_id = ? AND attribution.order_id = ?
            AND attribution.connection_id = ?
        )
    `).bind(
      nowIso,
      nowIso,
      claim.id,
      claim.shopId,
      claim.leaseToken,
      nowIso,
      claim.version,
      claim.shopId,
      nowIso,
      claim.shopId,
      claim.aggregateId,
      connectionId,
    ),
    env.PLATFORM_DB.prepare(`
      INSERT INTO delivery_jobs (
        id, shop_id, event_id, connection_id, purpose, queue_kind,
        idempotency_key_hash, status, attempts, next_attempt_at,
        version, created_at, updated_at
      )
      SELECT ?, event.shop_id, event.id, ?, ?, 'notification', ?,
        'pending', 0, ?, 1, ?, ?
      FROM domain_events AS event
      INNER JOIN shops ON shops.id = event.shop_id AND shops.status = 'active'
      INNER JOIN order_channel_attributions AS attribution
        ON attribution.shop_id = event.shop_id
        AND attribution.order_id = event.aggregate_id
        AND attribution.connection_id = ?
      INNER JOIN channel_connections AS connection
        ON connection.shop_id = attribution.shop_id
        AND connection.id = attribution.connection_id
        AND connection.status IN ('active', 'degraded')
      INNER JOIN shop_channels AS shop_channel
        ON shop_channel.shop_id = connection.shop_id
        AND shop_channel.id = connection.shop_channel_id
        AND shop_channel.status = 'enabled'
      INNER JOIN channel_connection_grants AS grant_row
        ON grant_row.shop_id = connection.shop_id
        AND grant_row.connection_id = connection.id
        AND grant_row.capability_code = 'conversation.outbound'
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
      WHERE event.id = ? AND event.shop_id = ? AND event.status = 'published'
        AND event.event_type = ? AND event.schema_version = 1
        AND event.aggregate_type = 'order' AND event.version = ?
      ON CONFLICT(shop_id, event_id, connection_id, purpose) DO NOTHING
    `).bind(
      jobId,
      connectionId,
      ORDER_PAID_PURPOSE,
      idempotencyHash,
      nowIso,
      nowIso,
      nowIso,
      connectionId,
      nowIso,
      claim.id,
      claim.shopId,
      ORDER_PAID_EVENT_TYPE,
      claim.version + 1,
    ),
  ]);
  if (changes(results[0]) !== 1) {
    return { createdJobs: 0, enqueueFailures: 0, enqueuedJobs: 0, eventId: claim.id, state: "not_claimed" };
  }
  let job: DeliveryJobReference | null;
  try {
    job = await env.PLATFORM_DB.prepare(`
      SELECT id, shop_id AS shopId, queue_kind AS queueKind
      FROM delivery_jobs
      WHERE shop_id = ? AND event_id = ? AND connection_id = ? AND purpose = ?
      LIMIT 1
    `).bind(
      claim.shopId,
      claim.id,
      connectionId,
      ORDER_PAID_PURPOSE,
    ).first<DeliveryJobReference>();
  } catch {
    return {
      createdJobs: changes(results[1]),
      enqueueFailures: 1,
      enqueuedJobs: 0,
      eventId: claim.id,
      state: "published",
    };
  }
  if (job === null) {
    return {
      createdJobs: changes(results[1]),
      enqueueFailures: 1,
      enqueuedJobs: 0,
      eventId: claim.id,
      state: "published",
    };
  }
  const enqueued = await enqueueDeliveryJob(env, job, nowIso);
  return {
    createdJobs: changes(results[1]),
    enqueueFailures: enqueued ? 0 : 1,
    enqueuedJobs: enqueued ? 1 : 0,
    eventId: claim.id,
    state: "published",
  };
}

async function dispatchClaimedDomainEvent(
  env: AppBindings,
  claim: DomainEventClaim,
  now: Date,
): Promise<DomainEventDispatchResult> {
  const nowIso = now.toISOString();
  if (claim.eventType !== ORDER_PAID_EVENT_TYPE
    || claim.schemaVersion !== 1
    || claim.aggregateType !== "order") {
    return publishUnsubscribedEvent(env.PLATFORM_DB, claim, nowIso);
  }
  const route = await loadClaimedEventRoute(env.PLATFORM_DB, claim, nowIso);
  if (route === null) {
    return { createdJobs: 0, enqueueFailures: 0, enqueuedJobs: 0, eventId: claim.id, state: "not_claimed" };
  }
  if (route.shopStatus !== "active") {
    return failClaimedEvent(env.PLATFORM_DB, claim, nowIso, "shop_inactive");
  }
  if (route.orderPaid !== 1) {
    return failClaimedEvent(env.PLATFORM_DB, claim, nowIso, "order_not_paid");
  }
  if (route.attributionExists !== 1) {
    return failClaimedEvent(env.PLATFORM_DB, claim, nowIso, "order_attribution_missing");
  }
  if (route.connectionId === null) {
    return publishEventWithoutDelivery(env.PLATFORM_DB, claim, nowIso);
  }
  if (!new Set(["active", "degraded"]).has(route.connectionStatus ?? "")
    || route.providerCode === null
    || route.shopChannelStatus !== "enabled"
    || route.grantActive !== 1) {
    return failClaimedEvent(env.PLATFORM_DB, claim, nowIso, "delivery_route_ineligible");
  }
  try {
    return await publishEventWithDelivery(env, claim, route.connectionId, nowIso);
  } catch {
    return retryClaimedEvent(env.PLATFORM_DB, claim, now, "domain_event_dispatch_failed");
  }
}

export async function dispatchDomainEventReference(input: {
  env: AppBindings;
  eventId: string;
  now?: Date;
  shopId: string;
}): Promise<DomainEventDispatchResult> {
  const now = input.now ?? new Date();
  assertIdentifier(input.eventId, "event_id_invalid");
  assertIdentifier(input.shopId, "shop_id_invalid");
  const reference = await input.env.PLATFORM_DB.prepare(`
    SELECT version FROM domain_events
    WHERE id = ? AND shop_id = ?
      AND (
        (status IN ('pending', 'retryable') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_expires_at <= ?)
      )
    LIMIT 1
  `).bind(
    input.eventId,
    input.shopId,
    now.toISOString(),
    now.toISOString(),
  ).first<{ version: number }>();
  if (reference === null) {
    return { createdJobs: 0, enqueueFailures: 0, enqueuedJobs: 0, eventId: input.eventId, state: "not_claimed" };
  }
  const claim = await claimDomainEvent({
    database: input.env.PLATFORM_DB,
    eventId: input.eventId,
    expectedVersion: reference.version,
    now,
    shopId: input.shopId,
  });
  if (claim === null) {
    return { createdJobs: 0, enqueueFailures: 0, enqueuedJobs: 0, eventId: input.eventId, state: "not_claimed" };
  }
  return dispatchClaimedDomainEvent(input.env, claim, now);
}

export async function dispatchDueDomainEvents(
  env: AppBindings,
  now = new Date(),
  shopId: string | null = null,
  limit = MAX_BATCH_SIZE,
): Promise<DomainEventDispatchBatchResult> {
  assertLimit(limit);
  if (shopId !== null) assertIdentifier(shopId, "shop_id_invalid");
  const candidates = await listDueDomainEvents(env.PLATFORM_DB, now.toISOString(), limit, shopId);
  const summary: DomainEventDispatchBatchResult = {
    candidates: candidates.length,
    createdJobs: 0,
    enqueueFailures: 0,
    enqueuedJobs: 0,
    failed: 0,
    notClaimed: 0,
    published: 0,
    retryable: 0,
  };
  for (const candidate of candidates) {
    const claim = await claimDomainEvent({
      database: env.PLATFORM_DB,
      eventId: candidate.id,
      expectedVersion: candidate.version,
      now,
      shopId: candidate.shopId,
    });
    const result = claim === null
      ? { createdJobs: 0, enqueueFailures: 0, enqueuedJobs: 0, eventId: candidate.id, state: "not_claimed" as const }
      : await dispatchClaimedDomainEvent(env, claim, now);
    summary.createdJobs += result.createdJobs;
    summary.enqueueFailures += result.enqueueFailures;
    summary.enqueuedJobs += result.enqueuedJobs;
    if (result.state === "failed") summary.failed += 1;
    else if (result.state === "published") summary.published += 1;
    else if (result.state === "retryable") summary.retryable += 1;
    else summary.notClaimed += 1;
  }
  return summary;
}

async function listDueDeliveryJobs(
  database: D1Database,
  nowIso: string,
  limit: number,
  shopId: string | null,
): Promise<DueDeliveryJob[]> {
  const result = await database.prepare(`
    SELECT job.id, job.shop_id AS shopId, job.queue_kind AS queueKind,
      job.status, job.version
    FROM delivery_jobs AS job
    INNER JOIN domain_events AS event
      ON event.shop_id = job.shop_id AND event.id = job.event_id
      AND event.status = 'published'
      AND event.event_type = 'order.paid' AND event.schema_version = 1
    INNER JOIN shops ON shops.id = job.shop_id AND shops.status = 'active'
    INNER JOIN channel_connections AS connection
      ON connection.shop_id = job.shop_id AND connection.id = job.connection_id
      AND connection.status IN ('active', 'degraded')
    INNER JOIN shop_channels AS shop_channel
      ON shop_channel.shop_id = connection.shop_id
      AND shop_channel.id = connection.shop_channel_id
      AND shop_channel.status = 'enabled'
    INNER JOIN channel_connection_grants AS grant_row
      ON grant_row.shop_id = connection.shop_id
      AND grant_row.connection_id = connection.id
      AND grant_row.capability_code = 'conversation.outbound'
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
    WHERE (? IS NULL OR job.shop_id = ?)
      AND job.purpose = 'order.paid'
      AND (
        (job.status IN ('pending', 'retryable') AND job.next_attempt_at <= ?)
        OR (job.status = 'processing' AND job.lease_expires_at <= ?)
      )
    ORDER BY COALESCE(job.next_attempt_at, job.lease_expires_at), job.id
    LIMIT ?
  `).bind(nowIso, shopId, shopId, nowIso, nowIso, limit).all<DueDeliveryJob>();
  return result.results;
}

export async function enqueueDueDeliveryJobs(
  env: AppBindings,
  now = new Date(),
  shopId: string | null = null,
  limit = MAX_BATCH_SIZE,
): Promise<DeliveryJobEnqueueResult> {
  assertLimit(limit);
  if (shopId !== null) assertIdentifier(shopId, "shop_id_invalid");
  const nowIso = now.toISOString();
  const candidates = await listDueDeliveryJobs(env.PLATFORM_DB, nowIso, limit, shopId);
  const result: DeliveryJobEnqueueResult = { candidates: candidates.length, failed: 0, sent: 0 };
  for (const candidate of candidates) {
    const sent = await enqueueDeliveryJob(env, candidate, nowIso);
    if (sent) result.sent += 1;
    else result.failed += 1;
  }
  return result;
}

export async function claimDeliveryJob(input: {
  database: D1Database;
  expectedVersion: number;
  jobId: string;
  now: Date;
  queueKind: QueueKind;
  shopId: string;
}): Promise<DeliveryJobClaim | null> {
  assertIdentifier(input.jobId, "delivery_job_id_invalid");
  assertIdentifier(input.shopId, "shop_id_invalid");
  assertVersion(input.expectedVersion);
  const nowIso = input.now.toISOString();
  const leaseToken = createOpaqueToken(18);
  const leaseExpiresAt = new Date(input.now.getTime() + DELIVERY_JOB_LEASE_MS).toISOString();
  const claimed = await input.database.prepare(`
    UPDATE delivery_jobs
    SET status = 'processing', attempts = attempts + 1, next_attempt_at = NULL,
      lease_token = ?, lease_expires_at = ?, last_safe_error_code = NULL,
      version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND queue_kind = ? AND version = ?
      AND (
        (status IN ('pending', 'retryable') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_expires_at <= ?)
      )
      AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND status = 'active')
      AND EXISTS (
        SELECT 1
        FROM domain_events AS event
        WHERE event.shop_id = delivery_jobs.shop_id
          AND event.id = delivery_jobs.event_id
          AND event.status = 'published'
          AND event.event_type = 'order.paid'
          AND event.schema_version = 1
          AND event.aggregate_type = 'order'
      )
      AND EXISTS (
        SELECT 1
        FROM channel_connections AS connection
        INNER JOIN shop_channels AS shop_channel
          ON shop_channel.shop_id = connection.shop_id
          AND shop_channel.id = connection.shop_channel_id
          AND shop_channel.status = 'enabled'
        INNER JOIN channel_connection_grants AS grant_row
          ON grant_row.shop_id = connection.shop_id
          AND grant_row.connection_id = connection.id
          AND grant_row.capability_code = 'conversation.outbound'
          AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
        WHERE connection.shop_id = delivery_jobs.shop_id
          AND connection.id = delivery_jobs.connection_id
          AND connection.status IN ('active', 'degraded')
      )
      AND EXISTS (
        SELECT 1
        FROM domain_events AS event
        INNER JOIN order_channel_attributions AS attribution
          ON attribution.shop_id = event.shop_id
          AND attribution.order_id = event.aggregate_id
          AND attribution.connection_id = delivery_jobs.connection_id
        WHERE event.shop_id = delivery_jobs.shop_id
          AND event.id = delivery_jobs.event_id
      )
  `).bind(
    leaseToken,
    leaseExpiresAt,
    nowIso,
    input.jobId,
    input.shopId,
    input.queueKind,
    input.expectedVersion,
    nowIso,
    nowIso,
    input.shopId,
    nowIso,
  ).run();
  if (changes(claimed) !== 1) return null;
  return input.database.prepare(`
    SELECT job.id, job.shop_id AS shopId, job.event_id AS eventId,
      job.connection_id AS connectionId, job.purpose,
      job.queue_kind AS queueKind, job.attempts,
      job.lease_token AS leaseToken, job.lease_expires_at AS leaseExpiresAt,
      job.version, event.aggregate_id AS orderId,
      connection.provider_code AS providerCode
    FROM delivery_jobs AS job
    INNER JOIN domain_events AS event
      ON event.shop_id = job.shop_id AND event.id = job.event_id
    INNER JOIN channel_connections AS connection
      ON connection.shop_id = job.shop_id AND connection.id = job.connection_id
    WHERE job.id = ? AND job.shop_id = ? AND job.status = 'processing'
      AND job.lease_token = ? AND job.version = ?
    LIMIT 1
  `).bind(
    input.jobId,
    input.shopId,
    leaseToken,
    input.expectedVersion + 1,
  ).first<DeliveryJobClaim>();
}

export async function claimDeliveryJobReference(input: {
  env: AppBindings;
  jobId: string;
  now?: Date;
  queueKind: QueueKind;
  shopId: string;
}): Promise<DeliveryJobClaim | null> {
  const now = input.now ?? new Date();
  assertIdentifier(input.jobId, "delivery_job_id_invalid");
  assertIdentifier(input.shopId, "shop_id_invalid");
  const reference = await input.env.PLATFORM_DB.prepare(`
    SELECT version FROM delivery_jobs
    WHERE id = ? AND shop_id = ? AND queue_kind = ?
      AND (
        (status IN ('pending', 'retryable') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_expires_at <= ?)
      )
    LIMIT 1
  `).bind(
    input.jobId,
    input.shopId,
    input.queueKind,
    now.toISOString(),
    now.toISOString(),
  ).first<{ version: number }>();
  if (reference === null) return null;
  return claimDeliveryJob({
    database: input.env.PLATFORM_DB,
    expectedVersion: reference.version,
    jobId: input.jobId,
    now,
    queueKind: input.queueKind,
    shopId: input.shopId,
  });
}

export async function settleDeliveryJob(input: {
  claim: DeliveryJobClaim;
  database: D1Database;
  now: Date;
  settlement: DeliveryJobSettlement;
}): Promise<boolean> {
  const nowIso = input.now.toISOString();
  let nextAttemptAt: string | null = null;
  let errorCode: string | null = null;
  let deliveredAt: string | null = null;
  let deadLetteredAt: string | null = null;
  if (input.settlement.status === "delivered") {
    deliveredAt = nowIso;
  } else {
    errorCode = input.settlement.errorCode;
    assertSafeCode(errorCode);
    if (input.settlement.status === "retryable") {
      assertIsoTimestamp(input.settlement.nextAttemptAt, "next_attempt_at_invalid");
      if (input.settlement.nextAttemptAt <= nowIso) throw runtimeError("next_attempt_at_not_future");
      nextAttemptAt = input.settlement.nextAttemptAt;
    } else if (input.settlement.status === "dead_letter") {
      deadLetteredAt = nowIso;
    }
  }
  const result = await input.database.prepare(`
    UPDATE delivery_jobs
    SET status = ?, next_attempt_at = ?, lease_token = NULL,
      lease_expires_at = NULL, last_safe_error_code = ?, delivered_at = ?,
      dead_lettered_at = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND status = 'processing'
      AND lease_token = ? AND lease_expires_at > ? AND version = ?
  `).bind(
    input.settlement.status,
    nextAttemptAt,
    errorCode,
    deliveredAt,
    deadLetteredAt,
    nowIso,
    input.claim.id,
    input.claim.shopId,
    input.claim.leaseToken,
    nowIso,
    input.claim.version,
  ).run();
  return changes(result) === 1;
}
