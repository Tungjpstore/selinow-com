import { describe, expect, it } from "vitest";

import type { PayOSCredentials } from "../../src/lib/payments/crypto";
import {
  assertPayOSChannelAdmitted,
  payOSProviderIdentityFingerprint,
  type PayOSAdmissionBindings,
} from "../../src/lib/payments/payos-admission";

const CREDENTIALS: PayOSCredentials = {
  apiKey: "staging-api-key",
  checksumKey: "staging-checksum-key",
  clientId: "controlled-staging-client-id",
};

function bindings(environment: "local" | "production" | "staging"): PayOSAdmissionBindings {
  return {
    APP_ENV: environment,
    IDENTIFIER_HMAC_SECRET: "payos-environment-admission-test-secret",
  };
}

describe("PayOS environment admission", () => {
  it("fails staging closed when no controlled channel fingerprint is configured", async () => {
    await expect(assertPayOSChannelAdmitted(bindings("staging"), CREDENTIALS))
      .rejects.toMatchObject({ code: "payment_provider_environment_not_admitted", status: 409 });
  });

  it("fails staging closed when the credential belongs to a different channel", async () => {
    const env = bindings("staging");
    env.PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT = await payOSProviderIdentityFingerprint(env, {
      ...CREDENTIALS,
      clientId: "different-staging-client-id",
    });

    await expect(assertPayOSChannelAdmitted(env, CREDENTIALS))
      .rejects.toMatchObject({ code: "payment_provider_environment_not_admitted", status: 409 });
  });

  it("admits only the explicitly fingerprinted controlled staging channel", async () => {
    const env = bindings("staging");
    env.PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT = await payOSProviderIdentityFingerprint(env, CREDENTIALS);

    await expect(assertPayOSChannelAdmitted(env, CREDENTIALS)).resolves.toBeUndefined();
  });

  it.each(["local", "production"] as const)("preserves %s behavior without staging attestation", async (environment) => {
    await expect(assertPayOSChannelAdmitted(bindings(environment), CREDENTIALS)).resolves.toBeUndefined();
  });
});
