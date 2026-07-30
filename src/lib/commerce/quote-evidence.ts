import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { toBase64Url } from "../core/ids";

const QUOTE_EVIDENCE_VERSION = 1;
// Keep signed quotes short-lived and reject tokens minted ahead of the verifier clock.
const MAX_QUOTE_LIFETIME_MS = 5 * 60_000;
const MAX_ISSUED_AT_FUTURE_SKEW_MS = 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type QuoteEvidenceExpectedItem = {
  /** Legacy callers may omit quantity; signed website quotes always include it. */
  quantity?: number;
  unitPriceMinor: number;
  variantId: string;
  variantVersion: number;
};

export type QuoteEvidenceCatalogItem = QuoteEvidenceExpectedItem & {
  productVersion: number;
};

type QuoteEvidenceClaims = {
  catalogHash?: string;
  cartId: string;
  discountCode?: string | null;
  discountMinor?: number;
  expectedHash: string;
  expiresAt: string;
  issuedAt: string;
  shopId: string;
  totalMinor?: number;
  version: number;
};

export type QuoteEvidencePricing = {
  discountCode: string | null;
  discountMinor: number;
  totalMinor: number;
};

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AppError("quote_invalid", 409);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    throw new AppError("quote_invalid", 409);
  }
}

async function expectedHash(items: readonly QuoteEvidenceExpectedItem[]): Promise<string> {
  return sha256Json([...items]
    .map((item) => ({
      quantity: item.quantity ?? 1,
      unitPriceMinor: item.unitPriceMinor,
      variantId: item.variantId,
      variantVersion: item.variantVersion,
    }))
    .sort((left, right) => left.variantId.localeCompare(right.variantId)));
}

async function catalogHash(items: readonly QuoteEvidenceCatalogItem[]): Promise<string> {
  return sha256Json([...items]
    .map((item) => ({
      productVersion: item.productVersion,
      quantity: item.quantity ?? 1,
      unitPriceMinor: item.unitPriceMinor,
      variantId: item.variantId,
      variantVersion: item.variantVersion,
    }))
    .sort((left, right) => left.variantId.localeCompare(right.variantId)));
}

function parseClaims(encodedClaims: string): QuoteEvidenceClaims {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(fromBase64Url(encodedClaims))) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("quote_invalid", 409);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("quote_invalid", 409);
  const claims = value as Partial<QuoteEvidenceClaims>;
  if (
    claims.version !== QUOTE_EVIDENCE_VERSION
    || (claims.catalogHash !== undefined && typeof claims.catalogHash !== "string")
    || typeof claims.cartId !== "string"
    || typeof claims.expectedHash !== "string"
    || typeof claims.expiresAt !== "string"
    || typeof claims.issuedAt !== "string"
    || typeof claims.shopId !== "string"
  ) {
    throw new AppError("quote_invalid", 409);
  }
  return claims as QuoteEvidenceClaims;
}

export async function createQuoteEvidence(input: {
  catalog?: readonly QuoteEvidenceCatalogItem[];
  cartId: string;
  cartExpiresAt?: string;
  expected: readonly QuoteEvidenceExpectedItem[];
  expiresAt: string;
  issuedAt?: string;
  pricing?: QuoteEvidencePricing;
  secret: string;
  shopId: string;
}): Promise<string> {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const requestedExpiry = Date.parse(input.expiresAt);
  const cartExpiry = input.cartExpiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(input.cartExpiresAt);
  // Preserve the requested timestamp unless the cart expires sooner. Invalid
  // timestamps remain signed and are rejected by verification as malformed.
  const expiresAt = Number.isFinite(requestedExpiry) && Number.isFinite(cartExpiry) && cartExpiry < requestedExpiry
    ? new Date(cartExpiry).toISOString()
    : input.expiresAt;
  const claims: QuoteEvidenceClaims = {
    ...(input.catalog === undefined ? {} : { catalogHash: await catalogHash(input.catalog) }),
    cartId: input.cartId,
    ...(input.pricing === undefined ? {} : {
      discountCode: input.pricing.discountCode,
      discountMinor: input.pricing.discountMinor,
      totalMinor: input.pricing.totalMinor,
    }),
    expectedHash: await expectedHash(input.expected),
    expiresAt,
    issuedAt,
    shopId: input.shopId,
    version: QUOTE_EVIDENCE_VERSION,
  };
  const encodedClaims = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmacToken(input.secret, "commerce-quote-evidence:v1", encodedClaims);
  return `${encodedClaims}.${signature}`;
}

export async function verifyQuoteEvidence(input: {
  catalog?: readonly QuoteEvidenceCatalogItem[];
  cartId: string;
  cartExpiresAt?: string;
  evidence: string;
  expected: readonly QuoteEvidenceExpectedItem[];
  now?: Date;
  pricing?: QuoteEvidencePricing;
  requireCatalog?: boolean;
  secret: string;
  shopId: string;
}): Promise<void> {
  if (input.evidence.length < 40 || input.evidence.length > 4_096) throw new AppError("quote_invalid", 409);
  const parts = input.evidence.split(".");
  if (parts.length !== 2) throw new AppError("quote_invalid", 409);
  const [encodedClaims, suppliedSignature] = parts;
  if (encodedClaims === undefined || suppliedSignature === undefined) throw new AppError("quote_invalid", 409);
  const expectedSignature = await hmacToken(input.secret, "commerce-quote-evidence:v1", encodedClaims);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) throw new AppError("quote_invalid", 409);
  const claims = parseClaims(encodedClaims);
  const expiry = Date.parse(claims.expiresAt);
  const issuedAt = Date.parse(claims.issuedAt);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(expiry) || !Number.isFinite(issuedAt) || !Number.isFinite(nowMs) || issuedAt >= expiry) throw new AppError("quote_invalid", 409);
  if (expiry <= nowMs) throw new AppError("quote_expired", 409);
  if (issuedAt > nowMs + MAX_ISSUED_AT_FUTURE_SKEW_MS || expiry - issuedAt > MAX_QUOTE_LIFETIME_MS) throw new AppError("quote_invalid", 409);
  if (input.cartExpiresAt !== undefined) {
    const cartExpiry = Date.parse(input.cartExpiresAt);
    if (!Number.isFinite(cartExpiry) || expiry > cartExpiry) throw new AppError("quote_invalid", 409);
  }
  if (
    claims.cartId !== input.cartId
    || claims.shopId !== input.shopId
    || claims.expectedHash !== await expectedHash(input.expected)
  ) {
    throw new AppError("quote_invalid", 409);
  }
  if (input.requireCatalog === true && (claims.catalogHash === undefined || input.catalog === undefined)) {
    throw new AppError("quote_invalid", 409);
  }
  if (claims.catalogHash !== undefined && input.catalog !== undefined && claims.catalogHash !== await catalogHash(input.catalog)) {
    throw new AppError("quote_invalid", 409);
  }
  // New website quotes bind pricing state. Evidence minted before this claim
  // existed remains accepted for replay/backward compatibility.
  const hasPricingClaim = claims.discountCode !== undefined || claims.discountMinor !== undefined || claims.totalMinor !== undefined;
  if (input.pricing !== undefined && hasPricingClaim) {
    if (
      claims.discountMinor === undefined
      || claims.totalMinor === undefined
      || claims.discountCode !== input.pricing.discountCode
      || claims.discountMinor !== input.pricing.discountMinor
      || claims.totalMinor !== input.pricing.totalMinor
    ) throw new AppError("quote_invalid", 409);
  }
}
