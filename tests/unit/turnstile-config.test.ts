import { describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { resolveTurnstileConfiguration } from "../../src/lib/storefront/turnstile";

function environment(input: Partial<AppBindings>): AppBindings {
  return { APP_ENV: "local", ...input } as AppBindings;
}

describe("storefront Turnstile configuration", () => {
  it("ignores placeholder and incomplete key pairs", () => {
    expect(resolveTurnstileConfiguration(environment({ TURNSTILE_SECRET_KEY: "replace-me", TURNSTILE_SITE_KEY: "replace-me" }))).toBeNull();
    expect(resolveTurnstileConfiguration(environment({ TURNSTILE_SECRET_KEY: "0xSecretKeyThatLooksConfigured123456" }))).toBeNull();
  });

  it("accepts a real-looking site and secret key pair", () => {
    expect(resolveTurnstileConfiguration(environment({
      TURNSTILE_SECRET_KEY: " 0xSecretKeyThatLooksConfigured123456 ",
      TURNSTILE_SITE_KEY: " 0xSiteKeyThatLooksConfigured123 ",
    }))).toEqual({
      secretKey: "0xSecretKeyThatLooksConfigured123456",
      siteKey: "0xSiteKeyThatLooksConfigured123",
    });
  });

  it("allows official test keys only in local development", () => {
    const keys = {
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    };
    expect(resolveTurnstileConfiguration(environment(keys))).toEqual({
      secretKey: keys.TURNSTILE_SECRET_KEY,
      siteKey: keys.TURNSTILE_SITE_KEY,
    });
    expect(resolveTurnstileConfiguration(environment({ ...keys, APP_ENV: "staging" }))).toBeNull();
  });
});
