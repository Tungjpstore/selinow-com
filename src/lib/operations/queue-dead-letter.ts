import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import {
  recordDeadLetter,
  type DeadLetterMessageKind,
  type DeadLetterReferenceType,
} from "./dead-letters";
import { safeOperationsReference } from "./incidents";

const MAX_ENVELOPE_BYTES = 2_048;
const QUEUE_ENVELOPE_FIELDS = new Set([
  "kind",
  "operationId",
  "referenceId",
  "referenceType",
  "requestId",
  "shopId",
  "sourceQueue",
  "version",
]);
const QUEUE_KINDS = new Set<DeadLetterMessageKind | "infrastructure_smoke">([
  "domain_reconciliation",
  "infrastructure_smoke",
  "integration",
  "notification",
  "operations",
  "order_paid",
  "payment_exception",
  "telegram_delivery",
  "unknown",
]);
const REFERENCE_TYPES = new Set<DeadLetterReferenceType>([
  "backup_snapshot",
  "none",
  "order",
  "outbox_job",
  "payment_attempt",
  "payment_integration",
  "rotation_run",
  "shop_domain",
  "telegram_integration",
]);
const SOURCE_QUEUES = new Set(["integration", "notification"]);
const SECRET_LIKE_VALUE = /^(?:\d{6,12}:[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:sk|pk|rk|whsec)[_-][A-Za-z0-9_-]{16,}|-----BEGIN )/iu;

export type QueueReferenceEnvelope = {
  kind: DeadLetterMessageKind;
  operationId: string | null;
  referenceId: string | null;
  referenceType: DeadLetterReferenceType;
  requestId: string | null;
  shopId: string | null;
  sourceQueue: "integration" | "notification";
};

export type DeadLetterQueueMessage = {
  ack: () => void;
  attempts: number;
  body: unknown;
  id: string;
  retry: (options?: { delaySeconds?: number }) => void;
};

export type DeadLetterQueueBatch = {
  messages: readonly DeadLetterQueueMessage[];
  queue: string;
};

export type DeadLetterQueueResult = {
  persisted: number;
  rejected: number;
  retried: number;
};

function safeEnvelopeReference(value: unknown, issue: string): string {
  const reference = safeOperationsReference(value, issue);
  if (SECRET_LIKE_VALUE.test(reference)) {
    throw new AppError("operations_validation_failed", 400, [issue]);
  }
  return reference;
}

function optionalEnvelopeReference(value: unknown, issue: string): string | null {
  return value === undefined ? null : safeEnvelopeReference(value, issue);
}

function serializedEnvelopeSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_ENVELOPE_BYTES + 1;
  }
}

export function parseQueueReferenceEnvelope(value: unknown): QueueReferenceEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || serializedEnvelopeSize(value) > MAX_ENVELOPE_BYTES) {
    throw new AppError("operations_validation_failed", 400, ["queue_envelope_invalid"]);
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !QUEUE_ENVELOPE_FIELDS.has(key))) {
    throw new AppError("operations_validation_failed", 400, ["queue_envelope_field_invalid"]);
  }
  if (row.version !== 1 || typeof row.sourceQueue !== "string" || !SOURCE_QUEUES.has(row.sourceQueue)) {
    throw new AppError("operations_validation_failed", 400, ["queue_envelope_version_or_source_invalid"]);
  }
  if (typeof row.kind !== "string" || !QUEUE_KINDS.has(row.kind as DeadLetterMessageKind | "infrastructure_smoke")) {
    throw new AppError("operations_validation_failed", 400, ["queue_envelope_kind_invalid"]);
  }
  if (typeof row.referenceType !== "string" || !REFERENCE_TYPES.has(row.referenceType as DeadLetterReferenceType)) {
    throw new AppError("operations_validation_failed", 400, ["queue_envelope_reference_type_invalid"]);
  }
  const referenceType = row.referenceType as DeadLetterReferenceType;
  const referenceId = row.referenceId === undefined
    ? null
    : safeEnvelopeReference(row.referenceId, "queue_envelope_reference_id_invalid");
  if ((referenceType === "none" && referenceId !== null) || (referenceType !== "none" && referenceId === null)) {
    throw new AppError("operations_validation_failed", 400, ["queue_envelope_reference_invalid"]);
  }
  const shopId = row.shopId === null
    ? null
    : safeEnvelopeReference(row.shopId, "queue_envelope_shop_id_invalid");

  return {
    kind: row.kind === "infrastructure_smoke" ? "operations" : row.kind as DeadLetterMessageKind,
    operationId: optionalEnvelopeReference(row.operationId, "queue_envelope_operation_id_invalid"),
    referenceId,
    referenceType,
    requestId: optionalEnvelopeReference(row.requestId, "queue_envelope_request_id_invalid"),
    shopId,
    sourceQueue: row.sourceQueue as "integration" | "notification",
  };
}

function boundedAttempts(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

async function durableMessageId(value: string): Promise<string> {
  try {
    return safeOperationsReference(value, "message_id_invalid");
  } catch {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.slice(0, 2_048)));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `sha256:${hex}`;
  }
}

function safeQueueName(value: string): string {
  try {
    return safeOperationsReference(value, "queue_name_invalid");
  } catch {
    return "dead-letter";
  }
}

export function isDeadLetterQueue(queueName: string, appEnv: AppBindings["APP_ENV"]): boolean {
  return queueName === `selinow-dlq-${appEnv}`;
}

export async function consumeDeadLetterQueue(
  batch: DeadLetterQueueBatch,
  env: AppBindings,
): Promise<DeadLetterQueueResult> {
  const result: DeadLetterQueueResult = { persisted: 0, rejected: 0, retried: 0 };
  for (const message of batch.messages) {
    let envelope: QueueReferenceEnvelope | null = null;
    try {
      envelope = parseQueueReferenceEnvelope(message.body);
    } catch {
      result.rejected += 1;
    }

    try {
      const messageId = await durableMessageId(message.id);
      await recordDeadLetter({
        env,
        failureCode: envelope === null ? "queue_envelope_rejected" : "queue_retries_exhausted",
        messageId,
        messageKind: envelope?.kind ?? "unknown",
        providerAttempts: boundedAttempts(message.attempts),
        queueName: envelope?.sourceQueue ?? safeQueueName(batch.queue),
        ...(envelope?.referenceId === null || envelope?.referenceId === undefined
          ? {}
          : { referenceId: envelope.referenceId }),
        referenceType: envelope?.referenceType ?? "none",
        safeEnvelope: envelope === null
          ? {}
          : {
              ...(envelope.operationId === null ? {} : { operationId: envelope.operationId }),
              ...(envelope.requestId === null ? {} : { requestId: envelope.requestId }),
            },
        shopId: envelope?.shopId ?? null,
      });
      message.ack();
      result.persisted += 1;
    } catch {
      message.retry({ delaySeconds: 300 });
      result.retried += 1;
    }
  }
  return result;
}
