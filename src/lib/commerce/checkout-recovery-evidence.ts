import { constantTimeEqual, hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { toBase64Url } from "../core/ids";

const CHECKOUT_RECOVERY_VERSION = 1;
const MAX_ISSUED_AT_FUTURE_SKEW_MS = 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type CheckoutRecoveryClaims = {
  cartId: string;
  checkoutSubjectHash: string;
  expiresAt: string;
  issuedAt: string;
  requestHash: string;
  shopId: string;
  version: number;
};

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AppError("checkout_recovery_invalid", 409);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    throw new AppError("checkout_recovery_invalid", 409);
  }
}

function parseClaims(encodedClaims: string): CheckoutRecoveryClaims {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(fromBase64Url(encodedClaims))) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("checkout_recovery_invalid", 409);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("checkout_recovery_invalid", 409);
  const claims = value as Partial<CheckoutRecoveryClaims>;
  if (
    claims.version !== CHECKOUT_RECOVERY_VERSION
    || typeof claims.cartId !== "string"
    || typeof claims.checkoutSubjectHash !== "string"
    || typeof claims.expiresAt !== "string"
    || typeof claims.issuedAt !== "string"
    || typeof claims.requestHash !== "string"
    || typeof claims.shopId !== "string"
  ) {
    throw new AppError("checkout_recovery_invalid", 409);
  }
  return claims as CheckoutRecoveryClaims;
}

export async function createCheckoutRecoveryEvidence(input: {
  cartId: string;
  checkoutSubjectHash: string;
  expiresAt: string;
  issuedAt?: string;
  requestHash: string;
  secret: string;
  shopId: string;
}): Promise<string> {
  const claims: CheckoutRecoveryClaims = {
    cartId: input.cartId,
    checkoutSubjectHash: input.checkoutSubjectHash,
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    requestHash: input.requestHash,
    shopId: input.shopId,
    version: CHECKOUT_RECOVERY_VERSION,
  };
  const encodedClaims = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmacToken(input.secret, "commerce-checkout-recovery:v1", encodedClaims);
  return `${encodedClaims}.${signature}`;
}

export async function verifyCheckoutRecoveryEvidence(input: {
  cartExpiresAt: string;
  cartId: string;
  checkoutSubjectHash: string;
  evidence: string;
  now?: Date;
  requestHash: string;
  secret: string;
  shopId: string;
}): Promise<void> {
  if (input.evidence.length < 40 || input.evidence.length > 4_096) throw new AppError("checkout_recovery_invalid", 409);
  const parts = input.evidence.split(".");
  if (parts.length !== 2) throw new AppError("checkout_recovery_invalid", 409);
  const [encodedClaims, suppliedSignature] = parts;
  if (encodedClaims === undefined || suppliedSignature === undefined) throw new AppError("checkout_recovery_invalid", 409);
  const expectedSignature = await hmacToken(input.secret, "commerce-checkout-recovery:v1", encodedClaims);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) throw new AppError("checkout_recovery_invalid", 409);
  const claims = parseClaims(encodedClaims);
  const expiry = Date.parse(claims.expiresAt);
  const issuedAt = Date.parse(claims.issuedAt);
  const cartExpiry = Date.parse(input.cartExpiresAt);
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(expiry) || !Number.isFinite(issuedAt) || !Number.isFinite(cartExpiry) || !Number.isFinite(nowMs) || issuedAt >= expiry || expiry > cartExpiry) {
    throw new AppError("checkout_recovery_invalid", 409);
  }
  if (issuedAt > nowMs + MAX_ISSUED_AT_FUTURE_SKEW_MS) throw new AppError("checkout_recovery_invalid", 409);
  if (expiry <= nowMs) throw new AppError("checkout_recovery_expired", 409);
  if (
    claims.cartId !== input.cartId
    || claims.shopId !== input.shopId
    || !constantTimeEqual(claims.checkoutSubjectHash, input.checkoutSubjectHash)
    || !constantTimeEqual(claims.requestHash, input.requestHash)
  ) {
    throw new AppError("checkout_recovery_invalid", 409);
  }
}
