import { AppError } from "../core/errors";

const MAX_PROVIDER_ARTIFACT_LENGTH = 16_384;
const SAFE_PROVIDER_CODE = /^[a-z][a-z0-9._-]{1,63}$/u;

export type GeneratedLicenseFormat = "json" | "text";

export type GeneratedLicenseProviderRequest = Readonly<{
  idempotencyKey: string;
  operation: "generate" | "reconcile";
  orderReference: string;
  quantity: 1;
  requestReference: string;
  resourceKey: string;
  version: 1;
}>;

export type GeneratedLicenseProviderSuccess = Readonly<{
  artifact: string;
  evidence: Readonly<Record<string, boolean | number | string>>;
  format: GeneratedLicenseFormat;
  kind: "success";
  providerReference: string;
}>;

export type GeneratedLicenseProviderFailure = Readonly<{
  errorCode: string;
  kind: "ambiguous" | "permanent" | "retryable";
  providerReference?: string;
  retryAfterSeconds?: number;
}>;

export type GeneratedLicenseProviderResult = GeneratedLicenseProviderFailure | GeneratedLicenseProviderSuccess;

export type GeneratedLicenseProviderCall = Readonly<{
  credential: string;
  endpoint: string;
  request: GeneratedLicenseProviderRequest;
}>;

/** Provider adapters own provider I/O only and deliberately receive no D1 binding. */
export interface GeneratedLicenseProviderAdapter {
  readonly code: string;
  generate(input: GeneratedLicenseProviderCall): Promise<GeneratedLicenseProviderResult>;
  reconcile(input: GeneratedLicenseProviderCall): Promise<GeneratedLicenseProviderResult>;
}

export class GeneratedLicenseProviderRegistry {
  private readonly adapters: ReadonlyMap<string, GeneratedLicenseProviderAdapter>;

  constructor(adapters: readonly GeneratedLicenseProviderAdapter[]) {
    const entries = new Map<string, GeneratedLicenseProviderAdapter>();
    for (const adapter of adapters) {
      if (!SAFE_PROVIDER_CODE.test(adapter.code) || entries.has(adapter.code)) {
        throw new AppError("generated_license_provider_definition_invalid", 500);
      }
      entries.set(adapter.code, adapter);
    }
    this.adapters = entries;
  }

  resolve(code: string): GeneratedLicenseProviderAdapter {
    const adapter = this.adapters.get(code);
    if (adapter === undefined) throw new AppError("generated_license_provider_unsupported", 503);
    return adapter;
  }
}

function safeRetryAfter(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return Math.min(3_600, value);
}

function safeProviderReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 3 && normalized.length <= 256 ? normalized : null;
}

function safeArtifact(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 && value.length <= MAX_PROVIDER_ARTIFACT_LENGTH ? value : null;
}

/** Seller webhook adapter with a deliberately small, provider-neutral payload. */
export class SellerWebhookGeneratedLicenseAdapter implements GeneratedLicenseProviderAdapter {
  readonly code = "seller.webhook";

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async call(input: GeneratedLicenseProviderCall): Promise<GeneratedLicenseProviderResult> {
    let response: Response;
    try {
      response = await this.fetcher(input.endpoint, {
        body: JSON.stringify(input.request),
        headers: {
          authorization: `Bearer ${input.credential}`,
          "content-type": "application/json",
          "idempotency-key": input.request.idempotencyKey,
        },
        method: "POST",
        redirect: "error",
      });
    } catch {
      return { errorCode: "generated_license_provider_ambiguous", kind: "ambiguous" };
    }

    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      const retryAfterSeconds = safeRetryAfter(Number(response.headers.get("retry-after")));
      return {
        errorCode: "generated_license_provider_retryable",
        kind: "retryable",
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    if (!response.ok) return { errorCode: "generated_license_provider_rejected", kind: "permanent" };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { errorCode: "generated_license_provider_response_invalid", kind: "ambiguous" };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { errorCode: "generated_license_provider_response_invalid", kind: "ambiguous" };
    }
    const record = body as Record<string, unknown>;
    const artifact = safeArtifact(record.license ?? record.artifact);
    const providerReference = safeProviderReference(record.providerReference ?? record.reference);
    const format = record.format === "json" ? "json" : "text";
    if (artifact === null || providerReference === null) {
      return { errorCode: "generated_license_provider_response_invalid", kind: "ambiguous" };
    }
    return {
      artifact,
      evidence: { accepted: true, status: response.status },
      format,
      kind: "success",
      providerReference,
    };
  }

  generate(input: GeneratedLicenseProviderCall): Promise<GeneratedLicenseProviderResult> {
    return this.call(input);
  }

  reconcile(input: GeneratedLicenseProviderCall): Promise<GeneratedLicenseProviderResult> {
    return this.call(input);
  }
}
