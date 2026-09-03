export const CUSTOM_DOMAIN_TURNSTILE_ADMISSION_MAX_AGE_MS = 12 * 60 * 60 * 1_000;
// Admissions older than this are proactively refreshed by the reconciliation
// pass, leaving buffer before the 12-hour serve-gate expiry. It sits above the
// 6-hour active-domain polling cadence so healthy domains are not re-checked
// twice, and below the expiry by enough margin to survive failed refresh retries.
export const CUSTOM_DOMAIN_TURNSTILE_ADMISSION_REFRESH_AGE_MS = 7 * 60 * 60 * 1_000;
// Minimum spacing between proactive refresh attempts for one domain, so a
// failing Cloudflare lookup is retried without hammering the API each tick.
export const CUSTOM_DOMAIN_TURNSTILE_ADMISSION_REFRESH_RETRY_MS = 30 * 60 * 1_000;

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as JsonObject;
  return null;
}

function parseMetadata(value: string | JsonObject): JsonObject | null {
  if (typeof value !== "string") return jsonObject(value);
  try {
    return jsonObject(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

export function turnstileAdmissionWindow(now = new Date()): { earliest: string; latest: string } | null {
  const latestMs = now.getTime();
  if (!Number.isFinite(latestMs)) return null;
  return {
    earliest: new Date(latestMs - CUSTOM_DOMAIN_TURNSTILE_ADMISSION_MAX_AGE_MS).toISOString(),
    latest: new Date(latestMs).toISOString(),
  };
}

export function hasFreshExactTurnstileAdmission(input: {
  hostname: string;
  now?: Date;
  validationMetadataJson: string | JsonObject;
}): boolean {
  const metadata = parseMetadata(input.validationMetadataJson);
  const admission = jsonObject(metadata?.turnstile);
  const window = turnstileAdmissionWindow(input.now);
  if (admission === null || window === null || typeof admission.checkedAt !== "string") return false;

  const checkedAtMs = Date.parse(admission.checkedAt);
  return admission.hostname === input.hostname
    && admission.mode === "operator_managed"
    && admission.source === "cloudflare_widget_domains"
    && admission.status === "active"
    && Number.isFinite(checkedAtMs)
    && checkedAtMs >= Date.parse(window.earliest)
    && checkedAtMs <= Date.parse(window.latest);
}

export function turnstileAdmissionRefreshWindow(now = new Date()): { dueBefore: string; retryBefore: string } | null {
  const latestMs = now.getTime();
  if (!Number.isFinite(latestMs)) return null;
  return {
    dueBefore: new Date(latestMs - CUSTOM_DOMAIN_TURNSTILE_ADMISSION_REFRESH_AGE_MS).toISOString(),
    retryBefore: new Date(latestMs - CUSTOM_DOMAIN_TURNSTILE_ADMISSION_REFRESH_RETRY_MS).toISOString(),
  };
}

export function isExactTurnstileAdmissionRefreshDue(input: {
  hostname: string;
  now?: Date;
  validationMetadataJson: string | JsonObject;
}): boolean {
  const metadata = parseMetadata(input.validationMetadataJson);
  const admission = jsonObject(metadata?.turnstile);
  const nowMs = (input.now ?? new Date()).getTime();
  if (admission === null || !Number.isFinite(nowMs) || typeof admission.checkedAt !== "string") return false;

  const checkedAtMs = Date.parse(admission.checkedAt);
  return admission.hostname === input.hostname
    && admission.mode === "operator_managed"
    && admission.source === "cloudflare_widget_domains"
    && admission.status === "active"
    && Number.isFinite(checkedAtMs)
    && checkedAtMs <= nowMs
    && checkedAtMs <= nowMs - CUSTOM_DOMAIN_TURNSTILE_ADMISSION_REFRESH_AGE_MS;
}

export function customDomainTurnstileAdmissionSql(alias?: string, nowExpression = "'now'"): string {
  if (alias !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(alias)) {
    throw new TypeError("invalid_sql_alias");
  }
  const prefix = alias === undefined ? "" : `${alias}.`;
  const metadata = `${prefix}validation_metadata_json`;
  const hostname = `${prefix}hostname_normalized`;
  const checkedAt = `json_extract(${metadata}, '$.turnstile.checkedAt')`;
  return `json_extract(${metadata}, '$.turnstile.status') = 'active'
    AND json_extract(${metadata}, '$.turnstile.hostname') = ${hostname}
    AND json_extract(${metadata}, '$.turnstile.mode') = 'operator_managed'
    AND json_extract(${metadata}, '$.turnstile.source') = 'cloudflare_widget_domains'
    AND json_type(${metadata}, '$.turnstile.checkedAt') = 'text'
    AND julianday(${checkedAt}) IS NOT NULL
    AND julianday(${checkedAt}) >= julianday(${nowExpression}, '-12 hours')
    AND julianday(${checkedAt}) <= julianday(${nowExpression})`;
}
