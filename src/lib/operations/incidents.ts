import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";

const INCIDENT_CATEGORIES = [
  "queue_dead_letter",
  "outbox_failure",
  "provider_degraded",
  "security_limit",
  "encryption_rotation",
  "backup_failure",
  "restore_failure",
  "system_health",
] as const;
const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
const INCIDENT_SOURCES = [
  "queue",
  "outbox",
  "payment",
  "telegram",
  "domain",
  "security",
  "encryption",
  "backup",
  "restore",
  "system",
] as const;
const SAFE_CONTEXT_KEYS = new Set([
  "deadLetterId",
  "messageId",
  "operationId",
  "outboxJobId",
  "queueName",
  "requestId",
  "resourceId",
  "resourceType",
]);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type IncidentCategory = typeof INCIDENT_CATEGORIES[number];
export type IncidentSeverity = typeof INCIDENT_SEVERITIES[number];
export type IncidentSource = typeof INCIDENT_SOURCES[number];
export type IncidentStatus = "acknowledged" | "open" | "resolved";

type IncidentRow = {
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
  category: IncidentCategory;
  createdAt: string;
  firstSeenAt: string;
  id: string;
  incidentKey: string;
  lastSeenAt: string;
  occurrenceCount: number;
  resolutionCode: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  safeContextJson: string;
  severity: IncidentSeverity;
  shopId: string | null;
  sourceKind: IncidentSource;
  sourceRef: string;
  status: IncidentStatus;
  updatedAt: string;
  version: number;
};

export type IncidentView = Omit<IncidentRow, "safeContextJson"> & {
  safeContext: Record<string, string>;
};

export type ActiveIncidentList = {
  hasMore: boolean;
  items: IncidentView[];
  limit: number;
};

const INCIDENT_SELECT = `
  SELECT id, shop_id AS shopId, incident_key AS incidentKey, category, severity,
    status, source_kind AS sourceKind, source_ref AS sourceRef,
    safe_context_json AS safeContextJson, occurrence_count AS occurrenceCount,
    first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
    acknowledged_by_user_id AS acknowledgedByUserId, acknowledged_at AS acknowledgedAt,
    resolved_by_user_id AS resolvedByUserId, resolved_at AS resolvedAt,
    resolution_code AS resolutionCode, version, created_at AS createdAt,
    updated_at AS updatedAt
  FROM operations_incidents
`;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

export function safeOperationsReference(value: unknown, issue: string): string {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) {
    throw new AppError("operations_validation_failed", 400, [issue]);
  }
  return value;
}

function optionalActor(value: string | null): string | null {
  return value === null ? null : safeOperationsReference(value, "actor_user_id_invalid");
}

function safeExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError("operations_validation_failed", 400, ["expected_version_invalid"]);
  }
  return value;
}

export function operationsScopeKey(shopId: string | null): string {
  return shopId === null ? "platform" : `shop:${safeOperationsReference(shopId, "shop_id_invalid")}`;
}

export function safeReferenceEnvelope(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("operations_validation_failed", 400, ["safe_context_invalid"]);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_CONTEXT_KEYS.has(key)) {
      throw new AppError("operations_validation_failed", 400, ["safe_context_field_invalid"]);
    }
    output[key] = safeOperationsReference(item, `safe_context_${key}_invalid`);
  }
  return output;
}

function mapIncident(row: IncidentRow): IncidentView {
  const { safeContextJson, ...view } = row;
  const safeContext = (() => {
    try {
      return safeReferenceEnvelope(JSON.parse(safeContextJson) as unknown);
    } catch {
      return {};
    }
  })();
  return { ...view, safeContext };
}

async function findActiveIncident(
  env: AppBindings,
  scopeKey: string,
  incidentKey: string,
): Promise<IncidentRow | null> {
  return env.PLATFORM_DB.prepare(`${INCIDENT_SELECT}
    WHERE scope_key = ? AND incident_key = ? AND status IN ('open', 'acknowledged')
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).bind(scopeKey, incidentKey).first<IncidentRow>();
}

async function findIncidentById(
  env: AppBindings,
  id: string,
  shopId: string | null,
): Promise<IncidentRow | null> {
  return env.PLATFORM_DB.prepare(`${INCIDENT_SELECT}
    WHERE id = ? AND shop_id IS ? LIMIT 1
  `).bind(id, shopId).first<IncidentRow>();
}

function requireIncident(row: IncidentRow | null): IncidentRow {
  if (row === null) throw new AppError("operations_incident_not_found", 404);
  return row;
}

export async function listActiveIncidents(input: {
  env: AppBindings;
  limit?: number;
}): Promise<ActiveIncidentList> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("operations_validation_failed", 400, ["limit_invalid"]);
  }
  const result = await input.env.PLATFORM_DB.prepare(`${INCIDENT_SELECT}
    WHERE status IN ('open', 'acknowledged')
    ORDER BY CASE severity
      WHEN 'critical' THEN 4
      WHEN 'high' THEN 3
      WHEN 'medium' THEN 2
      ELSE 1
    END DESC, last_seen_at DESC, id
    LIMIT ?
  `).bind(limit + 1).all<IncidentRow>();
  return {
    hasMore: result.results.length > limit,
    items: result.results.slice(0, limit).map(mapIncident),
    limit,
  };
}

export async function upsertOpenIncident(input: {
  category: IncidentCategory;
  env: AppBindings;
  incidentKey: string;
  now?: Date;
  safeContext?: unknown;
  severity: IncidentSeverity;
  shopId: string | null;
  sourceKind: IncidentSource;
  sourceRef: string;
}): Promise<IncidentView> {
  if (!isOneOf(input.category, INCIDENT_CATEGORIES)
    || !isOneOf(input.severity, INCIDENT_SEVERITIES)
    || !isOneOf(input.sourceKind, INCIDENT_SOURCES)) {
    throw new AppError("operations_validation_failed", 400, ["incident_classification_invalid"]);
  }
  const scopeKey = operationsScopeKey(input.shopId);
  const incidentKey = safeOperationsReference(input.incidentKey, "incident_key_invalid");
  const sourceRef = safeOperationsReference(input.sourceRef, "source_ref_invalid");
  const safeContextJson = JSON.stringify(safeReferenceEnvelope(input.safeContext));
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await findActiveIncident(input.env, scopeKey, incidentKey);
    if (existing !== null) {
      if (existing.category !== input.category
        || existing.sourceKind !== input.sourceKind
        || existing.sourceRef !== sourceRef) {
        throw new AppError("operations_incident_identity_conflict", 409);
      }
      const updated = await input.env.PLATFORM_DB.prepare(`
        UPDATE operations_incidents
        SET status = 'open', severity = CASE
              WHEN ? = 'critical' OR severity = 'critical' THEN 'critical'
              WHEN ? = 'high' OR severity = 'high' THEN 'high'
              WHEN ? = 'medium' OR severity = 'medium' THEN 'medium'
              ELSE 'low'
            END,
            source_kind = ?, source_ref = ?, safe_context_json = ?,
            occurrence_count = occurrence_count + 1, last_seen_at = ?,
            acknowledged_by_user_id = NULL, acknowledged_at = NULL,
            resolved_by_user_id = NULL, resolved_at = NULL, resolution_code = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ? AND scope_key = ? AND incident_key = ?
          AND status IN ('open', 'acknowledged') AND version = ?
      `).bind(
        input.severity,
        input.severity,
        input.severity,
        input.sourceKind,
        sourceRef,
        safeContextJson,
        nowIso,
        nowIso,
        existing.id,
        scopeKey,
        incidentKey,
        existing.version,
      ).run();
      if (updated.meta.changes === 1) {
        return mapIncident(requireIncident(await findIncidentById(input.env, existing.id, input.shopId)));
      }
      continue;
    }

    const id = createId("inc");
    try {
      await input.env.PLATFORM_DB.prepare(`
        INSERT INTO operations_incidents (
          id, shop_id, scope_key, incident_key, category, severity, status,
          source_kind, source_ref, safe_context_json, occurrence_count,
          first_seen_at, last_seen_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?, 1, ?, ?)
      `).bind(
        id,
        input.shopId,
        scopeKey,
        incidentKey,
        input.category,
        input.severity,
        input.sourceKind,
        sourceRef,
        safeContextJson,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
      ).run();
      return mapIncident(requireIncident(await findIncidentById(input.env, id, input.shopId)));
    } catch (error) {
      if (await findActiveIncident(input.env, scopeKey, incidentKey) === null) throw error;
      // A concurrent insert won the partial unique index; retry the guarded update.
    }
  }
  throw new AppError("operations_incident_conflict", 409);
}

export async function acknowledgeIncident(input: {
  actorUserId: string | null;
  env: AppBindings;
  expectedVersion: number;
  incidentId: string;
  now?: Date;
  requestId: string;
  shopId: string | null;
}): Promise<IncidentView> {
  const incidentId = safeOperationsReference(input.incidentId, "incident_id_invalid");
  const actorUserId = optionalActor(input.actorUserId);
  const expectedVersion = safeExpectedVersion(input.expectedVersion);
  const requestId = safeOperationsReference(input.requestId, "request_id_invalid");
  const nowIso = (input.now ?? new Date()).toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, created_at, source_kind, correlation_id,
        operation_id, retention_class
      ) SELECT ?, ?, 'platform_admin', ?, 'operations.incident_acknowledged',
        'operations_incident', ?, '{}', ?, ?, 'http', ?, ?, 'security'
      WHERE EXISTS (
        SELECT 1 FROM operations_incidents
        WHERE id = ? AND shop_id IS ? AND status = 'open' AND version = ?
      )
    `).bind(
      createId("aud"),
      input.shopId,
      actorUserId,
      incidentId,
      requestId,
      nowIso,
      requestId,
      incidentId,
      incidentId,
      input.shopId,
      expectedVersion,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE operations_incidents
      SET status = 'acknowledged', acknowledged_by_user_id = ?, acknowledged_at = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id IS ? AND status = 'open' AND version = ?
    `).bind(actorUserId, nowIso, nowIso, incidentId, input.shopId, expectedVersion),
  ]);
  if (results[1]?.meta.changes !== 1) {
    if (await findIncidentById(input.env, incidentId, input.shopId) === null) {
      throw new AppError("operations_incident_not_found", 404);
    }
    throw new AppError("operations_incident_conflict", 409);
  }
  if (results[0]?.meta.changes !== 1) throw new AppError("operations_incident_conflict", 409);
  return mapIncident(requireIncident(await findIncidentById(input.env, incidentId, input.shopId)));
}

export async function resolveIncident(input: {
  actorUserId: string | null;
  env: AppBindings;
  expectedVersion: number;
  incidentId: string;
  now?: Date;
  requestId: string;
  resolutionCode: string;
  shopId: string | null;
}): Promise<IncidentView> {
  const incidentId = safeOperationsReference(input.incidentId, "incident_id_invalid");
  const actorUserId = optionalActor(input.actorUserId);
  const expectedVersion = safeExpectedVersion(input.expectedVersion);
  const requestId = safeOperationsReference(input.requestId, "request_id_invalid");
  const resolutionCode = safeOperationsReference(input.resolutionCode, "resolution_code_invalid");
  const nowIso = (input.now ?? new Date()).toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, created_at, source_kind, correlation_id,
        operation_id, retention_class
      ) SELECT ?, ?, 'platform_admin', ?, 'operations.incident_resolved',
        'operations_incident', ?, ?, ?, ?, 'http', ?, ?, 'security'
      WHERE EXISTS (
        SELECT 1 FROM operations_incidents
        WHERE id = ? AND shop_id IS ?
          AND status IN ('open', 'acknowledged') AND version = ?
      )
    `).bind(
      createId("aud"),
      input.shopId,
      actorUserId,
      incidentId,
      JSON.stringify({ resolutionCode }),
      requestId,
      nowIso,
      requestId,
      incidentId,
      incidentId,
      input.shopId,
      expectedVersion,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE operations_incidents
      SET status = 'resolved', resolved_by_user_id = ?, resolved_at = ?,
          resolution_code = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id IS ? AND status IN ('open', 'acknowledged') AND version = ?
    `).bind(
      actorUserId,
      nowIso,
      resolutionCode,
      nowIso,
      incidentId,
      input.shopId,
      expectedVersion,
    ),
  ]);
  if (results[1]?.meta.changes !== 1) {
    if (await findIncidentById(input.env, incidentId, input.shopId) === null) {
      throw new AppError("operations_incident_not_found", 404);
    }
    throw new AppError("operations_incident_conflict", 409);
  }
  if (results[0]?.meta.changes !== 1) throw new AppError("operations_incident_conflict", 409);
  return mapIncident(requireIncident(await findIncidentById(input.env, incidentId, input.shopId)));
}
