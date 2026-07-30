import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";

const SAFE_ATOM = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const SAFE_ACTION = /^[a-z][a-z0-9_.]{2,95}$/u;
const SAFE_RESOURCE = /^[a-z][a-z0-9_]{1,63}$/u;
const ALLOWED_METADATA_KEYS = new Set([
  "abuseReportId",
  "actorScope",
  "category",
  "deletionRequestId",
  "evidenceReference",
  "expectedVersion",
  "holdUntil",
  "newStatus",
  "previousStatus",
  "reasonCode",
  "reportPublicId",
  "targetKind",
]);

export type OperationsAuditActorType = "platform_admin" | "system" | "user";
export type OperationsAuditRetention = "financial" | "legal" | "security" | "standard";
export type OperationsAuditSource = "application" | "http" | "migration" | "queue" | "scheduled";
export type OperationsAuditMetadata = Record<string, boolean | number | string | null>;

export type OperationsAuditEvent = {
  action: string;
  actorId: string | null;
  actorType: OperationsAuditActorType;
  correlationId: string | null;
  createdAt: string;
  id: string;
  metadataJson: string;
  operationId: string | null;
  requestId: string;
  resourceId: string | null;
  resourceType: string;
  retentionClass: OperationsAuditRetention;
  shopId: string | null;
  sourceKind: OperationsAuditSource;
};

function safeAtom(value: string, issue: string): string {
  if (!SAFE_ATOM.test(value)) throw new AppError("operations_audit_invalid", 400, [issue]);
  return value;
}

function safeOptionalAtom(value: string | null, issue: string): string | null {
  return value === null ? null : safeAtom(value, issue);
}

function safeMetadata(value: OperationsAuditMetadata): string {
  const output: OperationsAuditMetadata = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw new AppError("operations_audit_invalid", 400, ["metadata_field_invalid"]);
    }
    if (typeof item === "string") output[key] = safeAtom(item, `metadata_${key}_invalid`);
    else if (typeof item === "number" && Number.isSafeInteger(item)) output[key] = item;
    else if (typeof item === "boolean" || item === null) output[key] = item;
    else throw new AppError("operations_audit_invalid", 400, [`metadata_${key}_invalid`]);
  }
  return JSON.stringify(output);
}

export function createOperationsAuditEvent(input: {
  action: string;
  actorId: string | null;
  actorType: OperationsAuditActorType;
  correlationId?: string | null;
  metadata?: OperationsAuditMetadata;
  now?: Date;
  operationId?: string | null;
  requestId: string;
  resourceId: string | null;
  resourceType: string;
  retentionClass?: OperationsAuditRetention;
  shopId: string | null;
  sourceKind?: OperationsAuditSource;
}): OperationsAuditEvent {
  if (!SAFE_ACTION.test(input.action) || !SAFE_RESOURCE.test(input.resourceType)) {
    throw new AppError("operations_audit_invalid", 400, ["classification_invalid"]);
  }
  return {
    action: input.action,
    actorId: safeOptionalAtom(input.actorId, "actor_id_invalid"),
    actorType: input.actorType,
    correlationId: safeOptionalAtom(input.correlationId ?? input.requestId, "correlation_id_invalid"),
    createdAt: (input.now ?? new Date()).toISOString(),
    id: createId("aud"),
    metadataJson: safeMetadata(input.metadata ?? {}),
    operationId: safeOptionalAtom(input.operationId ?? null, "operation_id_invalid"),
    requestId: safeAtom(input.requestId, "request_id_invalid"),
    resourceId: safeOptionalAtom(input.resourceId, "resource_id_invalid"),
    resourceType: input.resourceType,
    retentionClass: input.retentionClass ?? "standard",
    shopId: safeOptionalAtom(input.shopId, "shop_id_invalid"),
    sourceKind: input.sourceKind ?? "application",
  };
}

function auditBindings(event: OperationsAuditEvent): unknown[] {
  return [
    event.id,
    event.shopId,
    event.actorType,
    event.actorId,
    event.action,
    event.resourceType,
    event.resourceId,
    event.metadataJson,
    event.requestId,
    event.createdAt,
    event.sourceKind,
    event.correlationId,
    event.operationId,
    event.retentionClass,
  ];
}

const AUDIT_COLUMNS = `
  id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
  safe_metadata_json, request_id, created_at, source_kind, correlation_id,
  operation_id, metadata_version, retention_class
`;

const AUDIT_VALUES = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?";

export function prepareOperationsAuditInsert(
  env: Pick<AppBindings, "PLATFORM_DB">,
  event: OperationsAuditEvent,
): D1PreparedStatement {
  return env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (${AUDIT_COLUMNS})
    VALUES (${AUDIT_VALUES})
  `).bind(...auditBindings(event));
}

export function prepareOperationsAuditForAppliedModeration(
  env: Pick<AppBindings, "PLATFORM_DB">,
  event: OperationsAuditEvent,
  moderationActionId: string,
): D1PreparedStatement {
  return env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (${AUDIT_COLUMNS})
    SELECT ${AUDIT_VALUES}
    WHERE EXISTS (
      SELECT 1 FROM moderation_actions
      WHERE id = ? AND status = 'applied'
    )
  `).bind(...auditBindings(event), safeAtom(moderationActionId, "moderation_action_id_invalid"));
}

export function prepareOperationsAuditForReportTransition(
  env: Pick<AppBindings, "PLATFORM_DB">,
  event: OperationsAuditEvent,
  input: { reportId: string; status: string; updatedAt: string },
): D1PreparedStatement {
  return env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (${AUDIT_COLUMNS})
    SELECT ${AUDIT_VALUES}
    WHERE EXISTS (
      SELECT 1 FROM abuse_reports
      WHERE id = ? AND status = ? AND updated_at = ?
    )
  `).bind(
    ...auditBindings(event),
    safeAtom(input.reportId, "abuse_report_id_invalid"),
    safeAtom(input.status, "abuse_report_status_invalid"),
    input.updatedAt,
  );
}

export function prepareOperationsAuditForDeletionRequestVersion(
  env: Pick<AppBindings, "PLATFORM_DB">,
  event: OperationsAuditEvent,
  input: { controlMarker: string; requestId: string; shopId: string; updatedAt: string; version: number },
): D1PreparedStatement {
  return env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (${AUDIT_COLUMNS})
    SELECT ${AUDIT_VALUES}
    WHERE EXISTS (
      SELECT 1 FROM shop_deletion_requests
      WHERE id = ? AND shop_id = ? AND version = ? AND updated_at = ?
        AND last_safe_error_code = ?
    )
  `).bind(
    ...auditBindings(event),
    safeAtom(input.requestId, "deletion_request_id_invalid"),
    safeAtom(input.shopId, "shop_id_invalid"),
    input.version,
    input.updatedAt,
    safeAtom(input.controlMarker, "deletion_control_marker_invalid"),
  );
}
