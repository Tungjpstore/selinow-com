import { AppError } from "../core/errors";
import { constantTimeEqual } from "../core/crypto";
import type { PayOSCredentials } from "./crypto";
import { definePaymentProviderDescriptor } from "./provider";

const PAYOS_BASE_URL = "https://api-merchant.payos.vn";
const encoder = new TextEncoder();

export const PAYOS_PROVIDER_DESCRIPTOR = definePaymentProviderDescriptor({
  capabilities: ["checkout.create", "credential.health", "payment.reconcile", "webhook.verify"],
  code: "payos",
  connectionModes: ["bring_your_own"],
  settlementMode: "direct",
  supportedCurrencies: ["VND"],
  supportedPaymentMethods: ["bank_transfer_qr"],
});

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = value[key];
    return result;
  }, {});
}

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined || value === "null" || value === "undefined") return "";
  if (Array.isArray(value)) return JSON.stringify(value.map((item: unknown): unknown => typeof item === "object" && item !== null && !Array.isArray(item) ? sortObject(item as Record<string, unknown>) : item));
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "[object Object]";
}

export async function createPayOSObjectSignature(data: Record<string, unknown>, checksumKey: string): Promise<string> {
  const canonical = Object.keys(data).filter((key) => data[key] !== undefined).sort().map((key) => `${key}=${canonicalValue(data[key])}`).join("&");
  return hmacHex(checksumKey, canonical);
}

export async function createPaymentRequestSignature(data: { amount: number; cancelUrl: string; description: string; orderCode: number; returnUrl: string }, checksumKey: string): Promise<string> {
  return hmacHex(checksumKey, `amount=${String(data.amount)}&cancelUrl=${data.cancelUrl}&description=${data.description}&orderCode=${String(data.orderCode)}&returnUrl=${data.returnUrl}`);
}

export async function verifyPayOSWebhook(data: Record<string, unknown>, signature: string, checksumKey: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/u.test(signature)) return false;
  return constantTimeEqual(await createPayOSObjectSignature(data, checksumKey), signature);
}

export class PayOSProviderError extends AppError {
  readonly providerStatus: number;
  readonly writeOutcome: "ambiguous" | "definitive_rejection" | "not_applicable";

  constructor(
    code: string,
    status = 503,
    providerStatus = 0,
    writeOutcome: "ambiguous" | "definitive_rejection" | "not_applicable" = "not_applicable",
  ) {
    super(code, status);
    this.providerStatus = providerStatus;
    this.writeOutcome = writeOutcome;
  }
}

export function isDefinitivePayOSWebhookRejection(error: unknown): boolean {
  return error instanceof PayOSProviderError && error.writeOutcome === "definitive_rejection";
}

type PayOSEnvelope = { code: string; data?: unknown; desc?: string; signature?: string };

async function readBoundedJson(response: Response): Promise<PayOSEnvelope> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 256 * 1024) throw new PayOSProviderError("provider_response_too_large");
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
    return value as PayOSEnvelope;
  } catch {
    throw new PayOSProviderError("provider_response_invalid");
  }
}

function invalidProviderWriteResponse(): PayOSProviderError {
  return new PayOSProviderError("provider_response_invalid", 503, 200, "ambiguous");
}

export type PaymentLinkResponse = { accountName: string; accountNumber: string; amount: number; bin: string; checkoutUrl: string; currency: string; description: string; orderCode: number; paymentLinkId: string; qrCode: string; status: string };
export type PaymentLinkStatusResponse = { amount: number; amountPaid: number; amountRemaining: number; canceledAt?: string | null; currency: string; description: string; id: string; orderCode: number; status: string; transactions: Array<Record<string, unknown>> };

function parseConfirmedWebhook(value: unknown, expectedUrl: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidProviderWriteResponse();
  }
  const row = value as Record<string, unknown>;
  const requiredFields = ["accountName", "accountNumber", "name", "shortName", "webhookUrl"] as const;
  if (requiredFields.some((field) => typeof row[field] !== "string" || row[field].length === 0)
    || row.webhookUrl !== expectedUrl) {
    throw invalidProviderWriteResponse();
  }
}

export class PayOSClient {
  readonly credentials: PayOSCredentials;
  readonly fetcher: typeof fetch;

  constructor(credentials: PayOSCredentials, fetcher: typeof fetch = fetch) {
    this.credentials = credentials;
    this.fetcher = fetcher;
  }

  private async request(method: string, path: string, body?: Record<string, unknown>, verifyResponse = false, providerWrite = false): Promise<unknown> {
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(`${PAYOS_BASE_URL}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { "Content-Type": "application/json", "x-api-key": this.credentials.apiKey, "x-client-id": this.credentials.clientId },
        method,
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new PayOSProviderError("provider_timeout", 503, 0, providerWrite ? "ambiguous" : "not_applicable");
    }
    let envelope: PayOSEnvelope;
    try {
      envelope = await readBoundedJson(response);
    } catch (error) {
      if (!providerWrite || !(error instanceof PayOSProviderError)) throw error;
      throw new PayOSProviderError(error.code, error.status, response.status, "ambiguous");
    }
    if (!response.ok || envelope.code !== "00" || envelope.data === undefined) {
      const definitiveRejection = providerWrite
        && response.status >= 400
        && response.status < 500
        && response.status !== 408
        && response.status !== 425
        && response.status !== 429;
      throw new PayOSProviderError(
        "provider_rejected",
        response.status >= 500 ? 503 : 409,
        response.status,
        definitiveRejection ? "definitive_rejection" : providerWrite ? "ambiguous" : "not_applicable",
      );
    }
    if (verifyResponse) {
      if (typeof envelope.signature !== "string" || typeof envelope.data !== "object" || envelope.data === null || Array.isArray(envelope.data) || !await verifyPayOSWebhook(envelope.data as Record<string, unknown>, envelope.signature, this.credentials.checksumKey)) throw new PayOSProviderError("provider_signature_invalid");
    }
    return envelope.data;
  }

  async confirmWebhook(webhookUrl: string): Promise<void> {
    const data = await this.request("POST", "/confirm-webhook", { webhookUrl }, false, true);
    parseConfirmedWebhook(data, webhookUrl);
  }

  async createPaymentLink(input: { amount: number; cancelUrl: string; description: string; expiredAt: number; orderCode: number; returnUrl: string }): Promise<PaymentLinkResponse> {
    const signature = await createPaymentRequestSignature(input, this.credentials.checksumKey);
    const data = await this.request("POST", "/v2/payment-requests", { ...input, signature }, true);
    return parsePaymentLink(data);
  }

  async getPaymentLink(id: number | string): Promise<PaymentLinkStatusResponse> {
    const data = await this.request("GET", `/v2/payment-requests/${encodeURIComponent(String(id))}`, undefined, true);
    return parsePaymentStatus(data);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PayOSProviderError("provider_response_invalid");
  return value as Record<string, unknown>;
}

function parsePaymentLink(value: unknown): PaymentLinkResponse {
  const row = requireRecord(value);
  const requiredStrings = ["accountName", "accountNumber", "bin", "checkoutUrl", "currency", "description", "paymentLinkId", "qrCode", "status"] as const;
  if (requiredStrings.some((field) => typeof row[field] !== "string") || typeof row.amount !== "number" || typeof row.orderCode !== "number") throw new PayOSProviderError("provider_response_invalid");
  return row as PaymentLinkResponse;
}

function parsePaymentStatus(value: unknown): PaymentLinkStatusResponse {
  const row = requireRecord(value);
  if (typeof row.id !== "string" || typeof row.orderCode !== "number" || typeof row.amount !== "number" || typeof row.amountPaid !== "number" || typeof row.amountRemaining !== "number" || typeof row.currency !== "string" || typeof row.description !== "string" || typeof row.status !== "string" || !Array.isArray(row.transactions)) throw new PayOSProviderError("provider_response_invalid");
  return row as PaymentLinkStatusResponse;
}
