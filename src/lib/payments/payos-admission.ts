import { AppError } from "../core/errors";
import { constantTimeEqual, hmacToken } from "../core/crypto";
import type { AppBindings } from "../platform/bindings";
import type { PayOSCredentials } from "./crypto";

/**
 * A staging channel is admitted by its keyed client-id fingerprint, never by
 * storing or comparing the merchant client id in plaintext configuration.
 */
export type PayOSAdmissionBindings = Pick<AppBindings, "APP_ENV" | "IDENTIFIER_HMAC_SECRET"> & {
  PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT?: string;
};

const PAYOS_IDENTITY_PURPOSE = "payos-provider-identity:v1";
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export async function payOSProviderIdentityFingerprint(
  env: Pick<AppBindings, "IDENTIFIER_HMAC_SECRET">,
  credentials: PayOSCredentials,
): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, PAYOS_IDENTITY_PURPOSE, credentials.clientId.trim());
}

export async function assertPayOSChannelAdmitted(
  env: PayOSAdmissionBindings,
  credentials: PayOSCredentials,
): Promise<void> {
  if (env.APP_ENV !== "staging") return;

  const expected = env.PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT?.trim();
  if (expected === undefined || !FINGERPRINT_PATTERN.test(expected)) {
    throw new AppError("payment_provider_environment_not_admitted", 409);
  }
  const actual = await payOSProviderIdentityFingerprint(env, credentials);
  if (!constantTimeEqual(actual, expected)) {
    throw new AppError("payment_provider_environment_not_admitted", 409);
  }
}
