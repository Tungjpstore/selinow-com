import { constantTimeEqual } from "../core/crypto";
import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";

/** Dodo-specific data stays isolated from the billing state machine. */
export type DodoConfig = {
  apiKey: string;
  apiBaseUrl: string;
  environment: "test_mode" | "live_mode";
  webhookSecret: string;
};

export type DodoCheckout = {
  providerTransactionId: string;
  checkoutUrl: string;
};

export type DodoSubscriptionOperation = {
  providerActionRef: string;
};

export type DodoSubscription = {
  priceId: string | null;
  providerSubscriptionId: string;
  status: string | null;
};

export type DodoBillingEvent = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  status: string | null;
  providerSubscriptionId: string | null;
  providerTransactionId: string | null;
  customData: Record<string, unknown>;
  amountMinor: number | null;
  currency: string | null;
  priceId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};

type DodoBindings = AppBindings & {
  DODO_PAYMENTS_API_KEY?: string;
  DODO_PAYMENTS_API_BASE_URL?: string;
  DODO_PAYMENTS_ENVIRONMENT?: string;
  DODO_PAYMENTS_WEBHOOK_KEY?: string;
  DODO_PAYMENTS_WEBHOOK_SECRET?: string;
  // Short aliases are accepted for local/staging deployments during migration.
  DODO_API_KEY?: string;
  DODO_API_BASE_URL?: string;
  DODO_ENVIRONMENT?: string;
  DODO_WEBHOOK_SECRET?: string;
};

const DEFAULT_API_URLS = {
  live_mode: "https://live.dodopayments.com",
  test_mode: "https://test.dodopayments.com",
} as const;

const CHECKOUT_HOSTS = new Set([
  "checkout.dodopayments.com",
  "test.checkout.dodopayments.com",
]);

const CURRENCY_EXPONENTS: Record<string, number> = { JPY: 0, KRW: 0, VND: 0 };

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function requireNonEmpty(value: unknown, issue: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || hasControlCharacter(value)) {
    throw new AppError("billing_provider_invalid", 502, [issue]);
  }
  return value;
}

export function getDodoConfig(env: AppBindings): DodoConfig {
  const bindings = env as DodoBindings;
  const requestedEnvironment = bindings.DODO_PAYMENTS_ENVIRONMENT ?? bindings.DODO_ENVIRONMENT;
  if (requestedEnvironment !== undefined && requestedEnvironment !== "test_mode" && requestedEnvironment !== "live_mode" && requestedEnvironment !== "sandbox" && requestedEnvironment !== "production") {
    throw new AppError("billing_provider_invalid", 502, ["environment"]);
  }
  const environment: DodoConfig["environment"] = requestedEnvironment === undefined
    ? (env.APP_ENV === "production" ? "live_mode" : "test_mode")
    : requestedEnvironment === "test_mode" || requestedEnvironment === "sandbox" ? "test_mode" : "live_mode";
  if (env.APP_ENV === "production" && environment !== "live_mode") throw new AppError("billing_provider_invalid", 502, ["environment"]);
  const apiKey = bindings.DODO_PAYMENTS_API_KEY ?? bindings.DODO_API_KEY;
  const webhookSecret = bindings.DODO_PAYMENTS_WEBHOOK_KEY ?? bindings.DODO_PAYMENTS_WEBHOOK_SECRET ?? bindings.DODO_WEBHOOK_SECRET;
  if (typeof apiKey !== "string" || apiKey.length < 16 || typeof webhookSecret !== "string" || webhookSecret.length < 16) {
    // Do not reveal which binding is missing. Provider configuration errors are
    // intentionally safe to expose only as a generic unavailable response.
    throw new AppError("billing_provider_unavailable", 503);
  }
  const configuredUrl = bindings.DODO_PAYMENTS_API_BASE_URL ?? bindings.DODO_API_BASE_URL;
  const apiBaseUrl = configuredUrl === undefined ? DEFAULT_API_URLS[environment] : requireNonEmpty(configuredUrl, "api_base_url");
  if (!/^https:\/\//u.test(apiBaseUrl) && env.APP_ENV !== "local") throw new AppError("billing_provider_invalid", 502, ["api_base_url"]);
  return { apiBaseUrl: apiBaseUrl.replace(/\/+$/u, ""), apiKey, environment, webhookSecret };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function readDate(value: unknown): string | null {
  const text = readString(value);
  if (text === null || Number.isNaN(Date.parse(text))) return null;
  return text;
}

function readMetadata(value: unknown): Record<string, unknown> {
  const object = asObject(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(key)) continue;
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") result[key] = entry;
  }
  return result;
}

function decimalToMinor(value: unknown, currency: string | null): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/u.test(text) || currency === null) return null;
  const exponent = CURRENCY_EXPONENTS[currency] ?? 2;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > exponent && /[^0]/u.test(fraction.slice(exponent))) return null;
  const padded = fraction.padEnd(exponent, "0").slice(0, exponent);
  const minor = Number(`${whole ?? ""}${padded}` || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

function minorAmount(value: unknown, currency: string | null): number | null {
  // Dodo amounts are already in the lowest denomination (including USD cents).
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const amount = Number(value.trim());
    return Number.isSafeInteger(amount) ? amount : null;
  }
  return decimalToMinor(value, currency);
}

function findPriceId(data: Record<string, unknown>): string | null {
  const direct = readString(data.product_id) ?? readString(data.price_id);
  if (direct !== null) return direct;
  const product = asObject(data.product);
  const nested = readString(product.id) ?? readString(product.product_id);
  if (nested !== null) return nested;
  const itemLists = [data.product_cart, data.items, data.line_items];
  for (const candidate of itemLists) {
    if (!Array.isArray(candidate)) continue;
    for (const itemValue of candidate) {
      const item = asObject(itemValue);
      const id = readString(item.product_id) ?? readString(item.price_id) ?? readString(asObject(item.product).id);
      if (id !== null) return id;
    }
  }
  return null;
}

/** Normalize Dodo's envelope while retaining only safe, provider-neutral fields. */
export function parseDodoEvent(payload: unknown, webhookId?: string | null): DodoBillingEvent {
  const envelope = asObject(payload);
  const data = asObject(envelope.data);
  const eventId = readString(envelope.event_id) ?? readString(envelope.id) ?? readString(webhookId);
  const eventType = readString(envelope.type) ?? readString(envelope.event_type);
  const occurredAt = readDate(envelope.timestamp) ?? readDate(envelope.occurred_at);
  if (eventId === null || eventType === null || occurredAt === null) throw new AppError("billing_webhook_invalid", 400, ["event_identity"]);
  const customData = readMetadata(data.metadata ?? data.custom_data ?? envelope.metadata);
  const checkoutSessionId = readString(data.checkout_session_id) ?? readString(data.checkout_id) ?? readString(data.session_id);
  if (checkoutSessionId !== null && customData.checkoutSessionId === undefined && customData.checkout_session_id === undefined) customData.checkoutSessionId = checkoutSessionId;
  const currency = (readString(data.currency) ?? readString(data.currency_code) ?? readString(data.billing_currency))?.toUpperCase() ?? null;
  const amount = minorAmount(data.total_amount ?? data.amount ?? data.amount_minor ?? data.total, currency);
  const billingPeriod = asObject(data.billing_period ?? data.current_billing_period);
  const periodStart = readDate(data.period_start) ?? readDate(data.current_period_start) ?? readDate(data.previous_billing_date) ?? readDate(billingPeriod.starts_at) ?? readDate(billingPeriod.start);
  const periodEnd = readDate(data.period_end) ?? readDate(data.current_period_end) ?? readDate(data.next_billing_date) ?? readDate(billingPeriod.ends_at) ?? readDate(billingPeriod.end);
  const isSubscriptionEvent = eventType.startsWith("subscription.");
  return {
    amountMinor: amount,
    currency,
    customData,
    eventId,
    eventType,
    occurredAt,
    priceId: findPriceId(data),
    periodEnd,
    periodStart,
    providerSubscriptionId: readString(data.subscription_id) ?? (isSubscriptionEvent ? readString(data.id) : null),
    providerTransactionId: readString(data.payment_id) ?? readString(data.transaction_id) ?? (!isSubscriptionEvent ? readString(data.id) : null),
    status: readString(data.status),
  };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = atob(normalized);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function signatureKey(secret: string): Uint8Array {
  if (secret.startsWith("whsec_")) {
    const decoded = decodeBase64(secret.slice(6));
    if (decoded !== null && decoded.length > 0) return decoded;
  }
  return new TextEncoder().encode(secret);
}

/** Verify Standard Webhooks signatures against the exact raw request body. */
export async function verifyDodoWebhookSignature(input: {
  body: string;
  header: string | null;
  secret: string;
  webhookId?: string | null;
  timestamp?: string | null;
  now?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  if (input.header === null || input.header.length > 4096 || input.webhookId === null || input.webhookId === undefined || input.webhookId.length === 0 || input.webhookId.length > 256 || hasControlCharacter(input.webhookId) || input.timestamp === null || input.timestamp === undefined) return false;
  const timestampNumber = Number(input.timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!/^\d+$/u.test(input.timestamp) || !Number.isSafeInteger(timestampNumber) || Math.abs(now - timestampNumber) > tolerance) return false;
  const keyBytes = signatureKey(input.secret);
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${input.webhookId}.${input.timestamp}.${input.body}`)));
  const expectedBase64 = encodeBase64(digest);
  const expectedHex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signatures = input.header.split(/\s+/u).map((value) => value.trim()).filter(Boolean);
  return signatures.some((signature) => {
    const candidate = signature.startsWith("v1,") ? signature.slice(3) : signature;
    return constantTimeEqual(expectedBase64, candidate) || constantTimeEqual(expectedHex, candidate.toLowerCase());
  });
}

export async function createDodoCheckout(input: {
  config: DodoConfig;
  currency: string;
  idempotencyKey: string;
  priceId: string;
  customData: Record<string, string>;
  fetcher?: typeof fetch;
}): Promise<DodoCheckout> {
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/checkouts`, {
      body: JSON.stringify({
        billing_currency: input.currency.toUpperCase(),
        metadata: input.customData,
        product_cart: [{ product_id: input.priceId, quantity: 1 }],
      }),
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        "Content-Type": "application/json",
        // Dodo accepts this header for safe client retries even though the
        // checkout endpoint may also deduplicate on metadata/session identity.
        "Idempotency-Key": input.idempotencyKey,
      },
      method: "POST",
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throw new AppError("billing_provider_unavailable", 503);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["response_json"]); }
  const data = asObject(body);
  const providerTransactionId = readString(data.session_id) ?? readString(data.payment_id) ?? readString(data.id);
  const checkoutUrl = readString(data.checkout_url) ?? readString(data.checkoutUrl);
  if (providerTransactionId === null || checkoutUrl === null) throw new AppError("billing_provider_invalid", 502, ["checkout_response"]);
  let checkout: URL;
  try { checkout = new URL(checkoutUrl); } catch { throw new AppError("billing_provider_invalid", 502, ["checkout_url"]); }
  if (checkout.protocol !== "https:" || !CHECKOUT_HOSTS.has(checkout.hostname) || checkout.pathname.length < 2) throw new AppError("billing_provider_invalid", 502, ["checkout_url"]);
  return { checkoutUrl, providerTransactionId };
}

/** Retrieve a durable checkout reference without persisting the bearer URL. */
export async function retrieveDodoCheckout(input: {
  config: DodoConfig;
  providerTransactionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoCheckout> {
  const fetcher = input.fetcher ?? fetch;
  if (input.providerTransactionId.length < 3 || input.providerTransactionId.length > 160 || /[\s]/u.test(input.providerTransactionId)) throw new AppError("billing_provider_invalid", 502, ["checkout_reference"]);
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/checkouts/${encodeURIComponent(input.providerTransactionId)}`, {
      headers: { Authorization: `Bearer ${input.config.apiKey}` },
      method: "GET",
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throw new AppError("billing_provider_unavailable", 503);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["checkout_response_json"]); }
  const data = asObject(body);
  const checkoutUrl = readString(data.checkout_url) ?? readString(data.checkoutUrl);
  const providerTransactionId = readString(data.session_id) ?? readString(data.payment_id) ?? readString(data.id) ?? input.providerTransactionId;
  if (checkoutUrl === null) throw new AppError("billing_provider_invalid", 502, ["checkout_response_url"]);
  let checkout: URL;
  try { checkout = new URL(checkoutUrl); } catch { throw new AppError("billing_provider_invalid", 502, ["checkout_url"]); }
  if (checkout.protocol !== "https:" || !CHECKOUT_HOSTS.has(checkout.hostname) || checkout.pathname.length < 2) throw new AppError("billing_provider_invalid", 502, ["checkout_url"]);
  return { checkoutUrl, providerTransactionId };
}

/** Retrieve provider truth for webhook fields that Dodo may omit. */
export async function retrieveDodoSubscription(input: {
  config: DodoConfig;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoSubscription> {
  const fetcher = input.fetcher ?? fetch;
  if (input.providerSubscriptionId.length < 3 || input.providerSubscriptionId.length > 160 || /[\s]/u.test(input.providerSubscriptionId)) {
    throw new AppError("billing_provider_invalid", 502, ["subscription_reference"]);
  }
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`, {
      headers: { Authorization: `Bearer ${input.config.apiKey}` },
      method: "GET",
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throw new AppError("billing_provider_unavailable", 503);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["subscription_response_json"]); }
  const data = asObject(body);
  const providerSubscriptionId = readString(data.subscription_id) ?? readString(data.id) ?? input.providerSubscriptionId;
  if (providerSubscriptionId !== input.providerSubscriptionId) throw new AppError("billing_provider_invalid", 502, ["subscription_identity"]);
  return { priceId: findPriceId(data), providerSubscriptionId, status: readString(data.status) };
}

async function dodoSubscriptionOperation(input: {
  config: DodoConfig;
  method: "PATCH" | "POST";
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoSubscriptionOperation> {
  const fetcher = input.fetcher ?? fetch;
  if (input.providerSubscriptionId.length < 3 || input.providerSubscriptionId.length > 160 || /[\s]/u.test(input.providerSubscriptionId)) throw new AppError("billing_provider_invalid", 502, ["subscription_reference"]);
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}${input.path}`, {
      body: JSON.stringify(input.body),
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      method: input.method,
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throw new AppError("billing_provider_unavailable", 503);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["subscription_response_json"]); }
  const data = asObject(body);
  const providerActionRef = readString(data.id)
    ?? readString(data.change_id)
    ?? readString(data.subscription_id)
    ?? input.providerSubscriptionId;
  return { providerActionRef };
}

export async function changeDodoSubscription(input: {
  config: DodoConfig;
  effectiveAt: "immediately" | "next_billing_date";
  idempotencyKey: string;
  onPaymentFailure: "prevent_change" | "apply_change";
  priceId: string;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoSubscriptionOperation> {
  return dodoSubscriptionOperation({
    body: { effective_at: input.effectiveAt, on_payment_failure: input.onPaymentFailure, product_id: input.priceId },
    config: input.config,
    idempotencyKey: input.idempotencyKey,
    method: "POST",
    path: "/change-plan",
    providerSubscriptionId: input.providerSubscriptionId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}

export async function cancelDodoSubscription(input: {
  cancellationComment?: string;
  config: DodoConfig;
  idempotencyKey: string;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoSubscriptionOperation> {
  return dodoSubscriptionOperation({
    body: { cancel_at_next_billing_date: true, cancellation_comment: input.cancellationComment ?? "cancelled_by_customer", cancel_reason: "cancelled_by_customer" },
    config: input.config,
    idempotencyKey: input.idempotencyKey,
    method: "PATCH",
    path: "",
    providerSubscriptionId: input.providerSubscriptionId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}
