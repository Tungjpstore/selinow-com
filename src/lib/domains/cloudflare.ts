import { AppError } from "../core/errors";

const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_API_TIMEOUT_MS = 8_000;
export const CLOUDFLARE_MAX_RESPONSE_BYTES = 256 * 1024;

type CloudflareEnvelope = {
  errors?: unknown;
  result?: unknown;
  success?: unknown;
};

type CloudflareErrorItem = {
  code?: unknown;
};

export type CloudflareValidationRecord = {
  cname?: string;
  cname_target?: string;
  emails?: string[];
  http_body?: string;
  http_url?: string;
  status?: string;
  txt_name?: string;
  txt_value?: string;
};

export type CloudflareCustomHostnameSsl = {
  dcv_delegation_records?: CloudflareValidationRecord[];
  method?: string;
  status: string;
  type?: string;
  validation_records?: CloudflareValidationRecord[];
};

export type CloudflareCustomHostname = {
  hostname: string;
  id: string;
  ownership_verification?: {
    name: string;
    type: string;
    value: string;
  };
  ownership_verification_http?: {
    http_body: string;
    http_url: string;
  };
  ssl: CloudflareCustomHostnameSsl;
  status: string;
};

export class CloudflareProviderError extends AppError {
  readonly providerCode: number | null;
  readonly providerStatus: number;
  readonly retryAfter: number | null;

  constructor(code: string, status = 503, providerStatus = 0, providerCode: number | null = null, retryAfter: number | null = null) {
    super(code, status);
    this.providerCode = providerCode;
    this.providerStatus = providerStatus;
    this.retryAfter = retryAfter;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CloudflareProviderError("provider_response_invalid");
  return value as Record<string, unknown>;
}

async function readBoundedEnvelope(response: Response): Promise<CloudflareEnvelope> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CloudflareProviderError("provider_response_invalid");
  }
  if (new TextEncoder().encode(text).byteLength > CLOUDFLARE_MAX_RESPONSE_BYTES) {
    throw new CloudflareProviderError("provider_response_too_large");
  }
  try {
    return requireRecord(JSON.parse(text));
  } catch (error) {
    if (error instanceof CloudflareProviderError) throw error;
    throw new CloudflareProviderError("provider_response_invalid");
  }
}

function readProviderCode(envelope: CloudflareEnvelope): number | null {
  if (!Array.isArray(envelope.errors)) return null;
  const first = envelope.errors[0] as CloudflareErrorItem | undefined;
  return typeof first?.code === "number" && Number.isSafeInteger(first.code) ? first.code : null;
}

function readRetryAfter(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (value === null || !/^\d+$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 86_400) : null;
}

function mapProviderError(response: Response, envelope: CloudflareEnvelope): CloudflareProviderError {
  const providerCode = readProviderCode(envelope);
  if (response.status === 401 || response.status === 403) {
    return new CloudflareProviderError("cloudflare_unauthorized", 503, response.status, providerCode);
  }
  if (response.status === 404) {
    return new CloudflareProviderError("cloudflare_hostname_not_found", 404, response.status, providerCode);
  }
  if (response.status === 429) {
    return new CloudflareProviderError("cloudflare_rate_limited", 503, response.status, providerCode, readRetryAfter(response));
  }
  if (response.status >= 500) {
    return new CloudflareProviderError("provider_unavailable", 503, response.status, providerCode);
  }
  return new CloudflareProviderError("cloudflare_request_rejected", 409, response.status, providerCode);
}

function optionalString(row: Record<string, unknown>, key: string, maxLength = 4_096): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function parseValidationRecord(value: unknown): CloudflareValidationRecord {
  const row = requireRecord(value);
  const cname = optionalString(row, "cname", 253);
  const cnameTarget = optionalString(row, "cname_target", 253);
  const emails = Array.isArray(row.emails)
    ? row.emails.filter((item): item is string => typeof item === "string" && item.length <= 320).slice(0, 20)
    : undefined;
  const httpBody = optionalString(row, "http_body");
  const httpUrl = optionalString(row, "http_url", 2_048);
  const status = optionalString(row, "status", 64);
  const txtName = optionalString(row, "txt_name", 253);
  const txtValue = optionalString(row, "txt_value");
  return {
    ...(cname === undefined ? {} : { cname }),
    ...(cnameTarget === undefined ? {} : { cname_target: cnameTarget }),
    ...(emails === undefined ? {} : { emails }),
    ...(httpBody === undefined ? {} : { http_body: httpBody }),
    ...(httpUrl === undefined ? {} : { http_url: httpUrl }),
    ...(status === undefined ? {} : { status }),
    ...(txtName === undefined ? {} : { txt_name: txtName }),
    ...(txtValue === undefined ? {} : { txt_value: txtValue }),
  };
}

function parseValidationRecords(value: unknown): CloudflareValidationRecord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new CloudflareProviderError("provider_response_invalid");
  return value.map(parseValidationRecord);
}

function parseCustomHostname(value: unknown): CloudflareCustomHostname {
  const row = requireRecord(value);
  const sslRow = requireRecord(row.ssl);
  if (
    typeof row.id !== "string"
    || row.id.length === 0
    || row.id.length > 128
    || typeof row.hostname !== "string"
    || row.hostname.length === 0
    || row.hostname.length > 253
    || typeof row.status !== "string"
    || row.status.length > 64
    || typeof sslRow.status !== "string"
    || sslRow.status.length > 64
  ) {
    throw new CloudflareProviderError("provider_response_invalid");
  }

  const validationRecords = parseValidationRecords(sslRow.validation_records);
  const dcvDelegationRecords = parseValidationRecords(sslRow.dcv_delegation_records);
  const sslMethod = optionalString(sslRow, "method", 32);
  const sslType = optionalString(sslRow, "type", 32);
  const ssl: CloudflareCustomHostnameSsl = {
    ...(dcvDelegationRecords === undefined ? {} : { dcv_delegation_records: dcvDelegationRecords }),
    ...(sslMethod === undefined ? {} : { method: sslMethod }),
    status: sslRow.status,
    ...(sslType === undefined ? {} : { type: sslType }),
    ...(validationRecords === undefined ? {} : { validation_records: validationRecords }),
  };

  const ownershipRow = row.ownership_verification === undefined ? undefined : requireRecord(row.ownership_verification);
  const ownershipHttpRow = row.ownership_verification_http === undefined ? undefined : requireRecord(row.ownership_verification_http);
  const ownership = ownershipRow === undefined ? undefined : {
    name: optionalString(ownershipRow, "name", 253),
    type: optionalString(ownershipRow, "type", 32),
    value: optionalString(ownershipRow, "value"),
  };
  const ownershipHttp = ownershipHttpRow === undefined ? undefined : {
    http_body: optionalString(ownershipHttpRow, "http_body"),
    http_url: optionalString(ownershipHttpRow, "http_url", 2_048),
  };
  if (ownership !== undefined && (ownership.name === undefined || ownership.type === undefined || ownership.value === undefined)) {
    throw new CloudflareProviderError("provider_response_invalid");
  }
  if (ownershipHttp !== undefined && (ownershipHttp.http_body === undefined || ownershipHttp.http_url === undefined)) {
    throw new CloudflareProviderError("provider_response_invalid");
  }

  return {
    hostname: row.hostname,
    id: row.id,
    ...(ownership === undefined ? {} : { ownership_verification: ownership as { name: string; type: string; value: string } }),
    ...(ownershipHttp === undefined ? {} : { ownership_verification_http: ownershipHttp as { http_body: string; http_url: string } }),
    ssl,
    status: row.status,
  };
}

export class CloudflareSaaSClient {
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  readonly fetcher: typeof fetch;
  readonly zoneId: string;

  constructor(apiToken: string, zoneId: string, fetcher: typeof fetch = fetch, timeoutMs = CLOUDFLARE_API_TIMEOUT_MS) {
    const normalizedApiToken = apiToken.trim();
    const normalizedZoneId = zoneId.trim();
    if (
      normalizedApiToken.length === 0
      || !/^[\x21-\x7e]+$/u.test(normalizedApiToken)
      || normalizedZoneId.length === 0
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > 30_000
    ) {
      throw new AppError("cloudflare_config_invalid", 500);
    }
    this.apiToken = normalizedApiToken;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.zoneId = normalizedZoneId;
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(`${CLOUDFLARE_API_ORIGIN}/zones/${encodeURIComponent(this.zoneId)}/custom_hostnames${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method,
        signal,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new CloudflareProviderError(signal.aborted || name === "AbortError" || name === "TimeoutError" ? "provider_timeout" : "provider_network_error");
    }

    const envelope = await readBoundedEnvelope(response);
    if (!response.ok || envelope.success !== true || envelope.result === undefined) throw mapProviderError(response, envelope);
    return envelope.result;
  }

  async createCustomHostname(hostname: string): Promise<CloudflareCustomHostname> {
    const result = await this.request("POST", "", {
      hostname,
      ssl: {
        method: "http",
        settings: { min_tls_version: "1.2" },
        type: "dv",
      },
    });
    return parseCustomHostname(result);
  }

  async findCustomHostname(hostname: string): Promise<CloudflareCustomHostname | null> {
    const result = await this.request("GET", `?hostname=${encodeURIComponent(hostname)}`);
    if (!Array.isArray(result) || result.length > 100) throw new CloudflareProviderError("provider_response_invalid");
    const matches = result.map(parseCustomHostname).filter((item) => item.hostname.toLowerCase() === hostname.toLowerCase());
    if (matches.length > 1) throw new CloudflareProviderError("provider_response_invalid");
    return matches[0] ?? null;
  }

  async getCustomHostname(id: string): Promise<CloudflareCustomHostname> {
    return parseCustomHostname(await this.request("GET", `/${encodeURIComponent(id)}`));
  }

  async deleteCustomHostname(id: string): Promise<void> {
    await this.request("DELETE", `/${encodeURIComponent(id)}`);
  }
}

export { CloudflareSaaSClient as CloudflareClient };
