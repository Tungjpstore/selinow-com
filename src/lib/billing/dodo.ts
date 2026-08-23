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
  checkoutUrl: string;
  providerCheckoutId: string;
  providerTransactionId: string;
};

export type DodoRetrievedCheckout = {
  amountMinor: number | null;
  checkoutUrl: string | null;
  createdAt: string;
  currency: string | null;
  paymentId: string | null;
  paymentStatus: string | null;
  priceId: string | null;
  providerCheckoutId: string;
  providerTransactionId: string;
  subscriptionId: string | null;
};

export type DodoPayment = {
  amountMinor: number | null;
  checkoutSessionId: string | null;
  currency: string | null;
  customData: Record<string, unknown>;
  customerId: string | null;
  invoiceId: string | null;
  paymentId: string;
  priceId: string | null;
  status: string | null;
  subscriptionId: string | null;
};

export type DodoSubscriptionOperation = {
  providerActionRef: string;
};

export type DodoPlanChangePreview = {
  amountMinor: number;
  currency: string;
};

export type DodoCustomerPortalSession = {
  link: string;
};

export type DodoSubscription = {
  cancelAtNextBillingDate: boolean | null;
  createdAt: string | null;
  customerId: string | null;
  previousBillingDate: string | null;
  nextBillingDate: string | null;
  priceId: string | null;
  providerSubscriptionId: string;
  scheduledPriceId: string | null;
  status: string | null;
  trialAmountMinor: number | null;
  trialPeriodDays: number | null;
};

export type DodoBillingEvent = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  status: string | null;
  providerSubscriptionId: string | null;
  providerCheckoutId: string | null;
  providerCustomerId: string | null;
  providerInvoiceId: string | null;
  providerPaymentId: string | null;
  providerTransactionId: string | null;
  customData: Record<string, unknown>;
  amountMinor: number | null;
  currency: string | null;
  priceId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  scheduledPriceId: string | null;
  cancelAtNextBillingDate: boolean | null;
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

const CHECKOUT_HOSTS = {
  live_mode: "checkout.dodopayments.com",
  test_mode: "test.checkout.dodopayments.com",
} as const;

function isDodoHostedPortalHostname(hostname: string): boolean {
  return hostname === "dodopayments.com" || hostname.endsWith(".dodopayments.com");
}

const CURRENCY_EXPONENTS: Record<string, number> = { JPY: 0, KRW: 0, VND: 0 };
const PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;

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

function readBinding(bindings: DodoBindings, name: keyof DodoBindings): unknown {
  return (bindings as unknown as Record<string, unknown>)[name];
}

export function getDodoConfig(env: AppBindings): DodoConfig {
  const bindings = env as DodoBindings;
  const requestedEnvironment = readBinding(bindings, "DODO_PAYMENTS_ENVIRONMENT")
    ?? readBinding(bindings, "DODO_ENVIRONMENT");
  if (requestedEnvironment !== undefined && requestedEnvironment !== "test_mode" && requestedEnvironment !== "live_mode") {
    throw new AppError("billing_provider_invalid", 502, ["environment"]);
  }
  const environment: DodoConfig["environment"] = requestedEnvironment === undefined
    ? (env.APP_ENV === "production" ? "live_mode" : "test_mode")
    : requestedEnvironment;
  if ((env.APP_ENV === "staging" && environment !== "test_mode") || (env.APP_ENV === "production" && environment !== "live_mode")) {
    throw new AppError("billing_provider_invalid", 502, ["environment"]);
  }
  const apiKey = bindings.DODO_PAYMENTS_API_KEY ?? bindings.DODO_API_KEY;
  const webhookSecret = bindings.DODO_PAYMENTS_WEBHOOK_KEY ?? bindings.DODO_PAYMENTS_WEBHOOK_SECRET ?? bindings.DODO_WEBHOOK_SECRET;
  if (typeof apiKey !== "string" || apiKey.length < 16 || typeof webhookSecret !== "string" || webhookSecret.length < 16) {
    // Do not reveal which binding is missing. Provider configuration errors are
    // intentionally safe to expose only as a generic unavailable response.
    throw new AppError("billing_provider_unavailable", 503);
  }
  const configuredUrl = readBinding(bindings, "DODO_PAYMENTS_API_BASE_URL")
    ?? readBinding(bindings, "DODO_API_BASE_URL");
  if (configuredUrl !== undefined && env.APP_ENV !== "local") throw new AppError("billing_provider_invalid", 502, ["api_base_url_override"]);
  const apiBaseUrl = configuredUrl === undefined ? DEFAULT_API_URLS[environment] : requireNonEmpty(configuredUrl, "api_base_url");
  let parsedApiBaseUrl: URL;
  try { parsedApiBaseUrl = new URL(apiBaseUrl); } catch { throw new AppError("billing_provider_invalid", 502, ["api_base_url"]); }
  if (!new Set(["http:", "https:"]).has(parsedApiBaseUrl.protocol)
    || parsedApiBaseUrl.username.length > 0
    || parsedApiBaseUrl.password.length > 0
    || parsedApiBaseUrl.search.length > 0
    || parsedApiBaseUrl.hash.length > 0
    || (configuredUrl === undefined && (parsedApiBaseUrl.protocol !== "https:" || parsedApiBaseUrl.hostname !== new URL(DEFAULT_API_URLS[environment]).hostname))) {
    throw new AppError("billing_provider_invalid", 502, ["api_base_url"]);
  }
  return { apiBaseUrl: apiBaseUrl.replace(/\/+$/u, ""), apiKey, environment, webhookSecret };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function readProviderReference(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_REFERENCE.test(value) ? value : null;
}

function requireProviderReference(value: unknown, issue: string): string {
  const reference = readProviderReference(value);
  if (reference === null) throw new AppError("billing_provider_invalid", 502, [issue]);
  return reference;
}

function throwCheckoutHttpError(response: Response): never {
  if (response.status >= 400 && response.status < 500 && !new Set([408, 425, 429]).has(response.status)) {
    throw new AppError("billing_provider_request_rejected", 502);
  }
  throw new AppError("billing_provider_unavailable", 503);
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

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function findPriceId(data: Record<string, unknown>): string | null {
  const direct = readProviderReference(data.product_id) ?? readProviderReference(data.price_id);
  if (direct !== null) return direct;
  const product = asObject(data.product);
  const nested = readProviderReference(product.id) ?? readProviderReference(product.product_id);
  if (nested !== null) return nested;
  const itemLists = [data.product_cart, data.items, data.line_items];
  for (const candidate of itemLists) {
    if (!Array.isArray(candidate)) continue;
    for (const itemValue of candidate) {
      const item = asObject(itemValue);
      const id = readProviderReference(item.product_id) ?? readProviderReference(item.price_id) ?? readProviderReference(asObject(item.product).id);
      if (id !== null) return id;
    }
  }
  return null;
}

function checkoutUrlForEnvironment(config: DodoConfig, value: unknown, issue: string): string {
  const checkoutUrl = readString(value);
  if (checkoutUrl === null) throw new AppError("billing_provider_invalid", 502, [issue]);
  let checkout: URL;
  try { checkout = new URL(checkoutUrl); } catch { throw new AppError("billing_provider_invalid", 502, ["checkout_url"]); }
  if (checkout.protocol !== "https:"
    || checkout.hostname !== CHECKOUT_HOSTS[config.environment]
    || checkout.port.length > 0
    || checkout.username.length > 0
    || checkout.password.length > 0
    || checkout.pathname.length < 2) {
    throw new AppError("billing_provider_invalid", 502, ["checkout_url"]);
  }
  return checkoutUrl;
}

/** Normalize Dodo's envelope while retaining only safe, provider-neutral fields. */
export function parseDodoEvent(payload: unknown, webhookId?: string | null): DodoBillingEvent {
  const envelope = asObject(payload);
  const data = asObject(envelope.data);
  // Standard Webhooks signs webhook-id as the delivery identity. Payload IDs
  // identify provider objects and must never replace the signed delivery ID.
  const eventId = readProviderReference(webhookId);
  const eventType = readString(envelope.type) ?? readString(envelope.event_type);
  const occurredAt = readDate(envelope.timestamp) ?? readDate(envelope.occurred_at);
  if (eventId === null || eventType === null || occurredAt === null) throw new AppError("billing_webhook_invalid", 400, ["event_identity"]);
  const customData = readMetadata(data.metadata ?? data.custom_data ?? envelope.metadata);
  const providerCheckoutId = readProviderReference(data.checkout_session_id) ?? readProviderReference(data.checkout_id) ?? readProviderReference(data.session_id);
  const customer = asObject(data.customer);
  const invoice = asObject(data.invoice);
  const providerCustomerId = readProviderReference(data.customer_id)
    ?? readProviderReference(customer.customer_id)
    ?? readProviderReference(customer.id);
  const providerInvoiceId = readProviderReference(data.invoice_id)
    ?? readProviderReference(invoice.invoice_id)
    ?? readProviderReference(invoice.id);
  const isSubscriptionEvent = eventType.startsWith("subscription.");
  const providerPaymentId = readProviderReference(data.payment_id)
    ?? readProviderReference(data.transaction_id)
    ?? (!isSubscriptionEvent ? readProviderReference(data.id) : null);
  const providerSubscriptionId = readProviderReference(data.subscription_id)
    ?? (isSubscriptionEvent ? readProviderReference(data.id) : null);
  const currency = (readString(data.currency) ?? readString(data.currency_code) ?? readString(data.billing_currency))?.toUpperCase() ?? null;
  const amount = minorAmount(data.total_amount ?? data.amount ?? data.amount_minor ?? data.total, currency);
  const billingPeriod = asObject(data.billing_period ?? data.current_billing_period);
  const scheduledChange = asObject(data.scheduled_change);
  const periodStart = readDate(data.period_start) ?? readDate(data.current_period_start) ?? readDate(data.previous_billing_date) ?? readDate(billingPeriod.starts_at) ?? readDate(billingPeriod.start);
  const periodEnd = readDate(data.period_end) ?? readDate(data.current_period_end) ?? readDate(data.next_billing_date) ?? readDate(billingPeriod.ends_at) ?? readDate(billingPeriod.end);
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
    providerCustomerId,
    providerInvoiceId,
    providerCheckoutId,
    providerPaymentId,
    providerSubscriptionId,
    // Compatibility alias for the service layer while it migrates to the
    // explicit checkout/payment fields.
    providerTransactionId: providerPaymentId ?? providerCheckoutId,
    status: readString(data.status),
    scheduledPriceId: findPriceId(scheduledChange),
    cancelAtNextBillingDate: typeof data.cancel_at_next_billing_date === "boolean" ? data.cancel_at_next_billing_date : null,
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
  const webhookId = readProviderReference(input.webhookId);
  if (input.header === null || input.header.length > 4096 || webhookId === null || input.timestamp === null || input.timestamp === undefined) return false;
  const timestampNumber = Number(input.timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!/^\d+$/u.test(input.timestamp) || !Number.isSafeInteger(timestampNumber) || Math.abs(now - timestampNumber) > tolerance) return false;
  const keyBytes = signatureKey(input.secret);
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${webhookId}.${input.timestamp}.${input.body}`)));
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
  returnUrl?: string;
  fetcher?: typeof fetch;
}): Promise<DodoCheckout> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const providerPriceId = requireProviderReference(input.priceId, "product_reference");
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/checkouts`, {
      body: JSON.stringify({
        billing_currency: input.currency.toUpperCase(),
        metadata: input.customData,
        product_cart: [{ product_id: providerPriceId, quantity: 1 }],
        ...(input.returnUrl === undefined ? {} : { return_url: input.returnUrl }),
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
  if (!response.ok) throwCheckoutHttpError(response);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["response_json"]); }
  const data = asObject(body);
  const providerCheckoutId = readProviderReference(data.session_id) ?? readProviderReference(data.checkout_id) ?? readProviderReference(data.id);
  const checkoutUrl = readString(data.checkout_url) ?? readString(data.checkoutUrl);
  if (providerCheckoutId === null || checkoutUrl === null) throw new AppError("billing_provider_invalid", 502, ["checkout_response"]);
  return {
    checkoutUrl: checkoutUrlForEnvironment(input.config, checkoutUrl, "checkout_response"),
    providerCheckoutId,
    providerTransactionId: providerCheckoutId,
  };
}

/** Retrieve a durable checkout reference without persisting the bearer URL. */
type RetrieveDodoCheckoutInput = {
  config: DodoConfig;
  providerTransactionId: string;
  fetcher?: typeof fetch;
};

export async function retrieveDodoCheckout(input: RetrieveDodoCheckoutInput): Promise<DodoRetrievedCheckout> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const requestedCheckoutId = requireProviderReference(input.providerTransactionId, "checkout_reference");
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/checkouts/${encodeURIComponent(requestedCheckoutId)}`, {
      headers: { Authorization: `Bearer ${input.config.apiKey}` },
      method: "GET",
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throwCheckoutHttpError(response);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["checkout_response_json"]); }
  const data = asObject(body);
  const checkoutUrl = readString(data.checkout_url) ?? readString(data.checkoutUrl);
  const providerCheckoutId = readProviderReference(data.id);
  const createdAt = readDate(data.created_at);
  if (providerCheckoutId !== requestedCheckoutId) throw new AppError("billing_provider_invalid", 502, ["checkout_identity"]);
  if (createdAt === null) throw new AppError("billing_provider_invalid", 502, ["checkout_created_at"]);
  const paymentId = readProviderReference(data.payment_id);
  const paymentStatus = readString(data.payment_status)?.trim().toLowerCase() ?? null;
  const subscriptionId = readProviderReference(data.subscription_id);
  const currency = (readString(data.currency) ?? readString(data.billing_currency))?.toUpperCase() ?? null;
  const amountMinor = minorAmount(data.total_amount ?? data.amount ?? data.amount_minor ?? data.total, currency);
  const priceId = findPriceId(data);
  const normalizedCheckoutUrl = checkoutUrl === null ? null : checkoutUrlForEnvironment(input.config, checkoutUrl, "checkout_response_url");
  return {
    amountMinor,
    checkoutUrl: normalizedCheckoutUrl,
    createdAt,
    currency,
    paymentId,
    paymentStatus,
    priceId,
    providerCheckoutId,
    providerTransactionId: providerCheckoutId,
    subscriptionId,
  };
}

/** Retrieve the captured payment before applying any subscription entitlement. */
export async function retrieveDodoPayment(input: {
  config: DodoConfig;
  paymentId: string;
  fetcher?: typeof fetch;
}): Promise<DodoPayment> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const requestedPaymentId = requireProviderReference(input.paymentId, "payment_reference");
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/payments/${encodeURIComponent(requestedPaymentId)}`, {
      headers: { Authorization: `Bearer ${input.config.apiKey}` },
      method: "GET",
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throwCheckoutHttpError(response);
  let body: unknown;
  try { body = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["payment_response_json"]); }
  const data = asObject(body);
  const paymentId = readProviderReference(data.payment_id) ?? readProviderReference(data.id) ?? requestedPaymentId;
  if (paymentId !== requestedPaymentId) throw new AppError("billing_provider_invalid", 502, ["payment_identity"]);
  const currency = readString(data.currency)?.toUpperCase() ?? null;
  const customer = asObject(data.customer);
  const invoice = asObject(data.invoice);
  return {
    amountMinor: minorAmount(data.total_amount ?? data.amount ?? data.amount_minor ?? data.total, currency),
    checkoutSessionId: readProviderReference(data.checkout_session_id) ?? readProviderReference(data.checkout_id),
    currency,
    customData: readMetadata(data.metadata),
    customerId: readProviderReference(data.customer_id)
      ?? readProviderReference(customer.customer_id)
      ?? readProviderReference(customer.id),
    invoiceId: readProviderReference(data.invoice_id)
      ?? readProviderReference(invoice.invoice_id)
      ?? readProviderReference(invoice.id),
    paymentId,
    priceId: findPriceId(data),
    status: readString(data.status)?.trim().toLowerCase() ?? null,
    subscriptionId: readProviderReference(data.subscription_id),
  };
}

/** Retrieve provider truth for webhook fields that Dodo may omit. */
export async function retrieveDodoSubscription(input: {
  config: DodoConfig;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoSubscription> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const requestedSubscriptionId = requireProviderReference(input.providerSubscriptionId, "subscription_reference");
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/subscriptions/${encodeURIComponent(requestedSubscriptionId)}`, {
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
  const providerSubscriptionId = readProviderReference(data.subscription_id) ?? readProviderReference(data.id) ?? requestedSubscriptionId;
  if (providerSubscriptionId !== requestedSubscriptionId) throw new AppError("billing_provider_invalid", 502, ["subscription_identity"]);
  const currency = (readString(data.currency) ?? readString(data.billing_currency))?.toUpperCase() ?? null;
  const scheduledChange = asObject(data.scheduled_change);
  const customer = asObject(data.customer);
  return {
    cancelAtNextBillingDate: typeof data.cancel_at_next_billing_date === "boolean" ? data.cancel_at_next_billing_date : null,
    createdAt: readDate(data.created_at),
    customerId: readProviderReference(data.customer_id) ?? readProviderReference(customer.customer_id) ?? readProviderReference(customer.id),
    previousBillingDate: readDate(data.previous_billing_date),
    nextBillingDate: readDate(data.next_billing_date),
    priceId: findPriceId(data),
    providerSubscriptionId,
    scheduledPriceId: findPriceId(scheduledChange),
    status: readString(data.status),
    trialAmountMinor: data.trial_amount === null ? null : minorAmount(data.trial_amount, currency),
    trialPeriodDays: nonNegativeInteger(data.trial_period_days),
  };
}

async function dodoSubscriptionOperation(input: {
  config: DodoConfig;
  method: "DELETE" | "PATCH" | "POST";
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey: string;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoSubscriptionOperation> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const providerSubscriptionId = requireProviderReference(input.providerSubscriptionId, "subscription_reference");
  let response: Response;
  try {
    const headers = new Headers({
      Authorization: `Bearer ${input.config.apiKey}`,
      "Idempotency-Key": input.idempotencyKey,
    });
    if (input.body !== undefined) headers.set("Content-Type", "application/json");
    response = await fetcher(`${input.config.apiBaseUrl}/subscriptions/${encodeURIComponent(providerSubscriptionId)}${input.path}`, {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers,
      method: input.method,
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throw new AppError("billing_provider_unavailable", 503);
  // Dodo mutation endpoints may acknowledge a successful operation with an
  // empty 200/202/204 response. The subscription itself is the durable
  // operation identity in that case; never turn a successful mutation into a
  // provider-invalid error merely because there is no JSON envelope.
  let data: Record<string, unknown> = {};
  try {
    const text = await response.text();
    if (text.trim().length > 0) {
      try {
        data = asObject(JSON.parse(text) as unknown);
      } catch {
        throw new AppError("billing_provider_invalid", 502, ["subscription_response_json"]);
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("billing_provider_invalid", 502, ["subscription_response_json"]);
  }
  const providerActionRef = readProviderReference(data.id)
    ?? readProviderReference(data.change_id)
    ?? readProviderReference(data.subscription_id)
    ?? providerSubscriptionId;
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
  const providerPriceId = requireProviderReference(input.priceId, "product_reference");
  return dodoSubscriptionOperation({
    body: {
      effective_at: input.effectiveAt,
      on_payment_failure: input.onPaymentFailure,
      product_id: providerPriceId,
      proration_billing_mode: input.effectiveAt === "immediately" ? "prorated_immediately" : "do_not_bill",
      quantity: 1,
    },
    config: input.config,
    idempotencyKey: input.idempotencyKey,
    method: "POST",
    path: "/change-plan",
    providerSubscriptionId: input.providerSubscriptionId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}

export async function previewDodoSubscriptionChange(input: {
  config: DodoConfig;
  effectiveAt: "immediately" | "next_billing_date";
  priceId: string;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoPlanChangePreview> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const subscriptionId = requireProviderReference(input.providerSubscriptionId, "subscription_reference");
  const productId = requireProviderReference(input.priceId, "product_reference");
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/subscriptions/${encodeURIComponent(subscriptionId)}/change-plan/preview`, {
      body: JSON.stringify({
        effective_at: input.effectiveAt,
        on_payment_failure: "prevent_change",
        product_id: productId,
        proration_billing_mode: input.effectiveAt === "immediately" ? "prorated_immediately" : "do_not_bill",
        quantity: 1,
      }),
      headers: { Authorization: `Bearer ${input.config.apiKey}`, "Content-Type": "application/json" },
      method: "POST",
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throw new AppError("billing_provider_unavailable", 503);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["change_plan_preview_json"]); }
  const immediateCharge = asObject(asObject(payload).immediate_charge);
  const summary = asObject(immediateCharge.summary);
  const currency = (readString(summary.currency) ?? readString(immediateCharge.currency))?.toUpperCase() ?? null;
  const amountMinor = minorAmount(summary.total_amount ?? immediateCharge.total_amount, currency);
  if (currency === null || amountMinor === null) throw new AppError("billing_provider_invalid", 502, ["change_plan_preview"]);
  return { amountMinor, currency };
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

export async function resumeDodoSubscription(input: {
  config: DodoConfig;
  idempotencyKey: string;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoSubscriptionOperation> {
  return dodoSubscriptionOperation({
    body: { cancel_at_next_billing_date: false },
    config: input.config,
    idempotencyKey: input.idempotencyKey,
    method: "PATCH",
    path: "",
    providerSubscriptionId: input.providerSubscriptionId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}

export async function cancelScheduledDodoPlanChange(input: {
  config: DodoConfig;
  idempotencyKey: string;
  providerSubscriptionId: string;
  fetcher?: typeof fetch;
}): Promise<DodoSubscriptionOperation> {
  return dodoSubscriptionOperation({
    config: input.config,
    idempotencyKey: input.idempotencyKey,
    method: "DELETE",
    path: "/change-plan/scheduled",
    providerSubscriptionId: input.providerSubscriptionId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}

export async function createDodoCustomerPortalSession(input: {
  config: DodoConfig;
  customerId: string;
  returnUrl: string;
  sendEmail?: boolean;
  fetcher?: typeof fetch;
}): Promise<DodoCustomerPortalSession> {
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const customerId = requireProviderReference(input.customerId, "customer_reference");
  const query = new URLSearchParams({ return_url: input.returnUrl });
  if (input.sendEmail !== undefined) query.set("send_email", String(input.sendEmail));
  let response: Response;
  try {
    response = await fetcher(`${input.config.apiBaseUrl}/customers/${encodeURIComponent(customerId)}/customer-portal/session?${query.toString()}`, {
      headers: { Authorization: `Bearer ${input.config.apiKey}` },
      method: "POST",
    });
  } catch {
    throw new AppError("billing_provider_unavailable", 503);
  }
  if (!response.ok) throw new AppError("billing_provider_unavailable", 503);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["customer_portal_response_json"]); }
  const link = readString(asObject(payload).link);
  if (link === null) throw new AppError("billing_provider_invalid", 502, ["customer_portal_link"]);
  let portalUrl: URL;
  try { portalUrl = new URL(link); } catch { throw new AppError("billing_provider_invalid", 502, ["customer_portal_link"]); }
  if (portalUrl.protocol !== "https:"
    || portalUrl.username.length > 0
    || portalUrl.password.length > 0
    || portalUrl.port.length > 0
    || portalUrl.pathname.length < 2
    || !isDodoHostedPortalHostname(portalUrl.hostname)) {
    throw new AppError("billing_provider_invalid", 502, ["customer_portal_link"]);
  }
  return { link: portalUrl.toString() };
}
