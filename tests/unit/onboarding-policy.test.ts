import { describe, expect, it } from "vitest";

import {
  CURRENT_POLICY_ATTESTATION_VERSION,
  parseOnboardingChannels,
  parseOnboardingSettings,
} from "../../src/lib/onboarding/policy";

describe("onboarding policy", () => {
  it("requires at least one entitled commerce channel selection", () => {
    expect(() => parseOnboardingChannels({
      customDomainPreference: "later",
      telegramEnabled: false,
      websiteEnabled: false,
    })).toThrow(expect.objectContaining({ code: "validation_failed", issues: ["onboarding_channel_required"] }));
  });

  it("requires website when the seller chooses to connect a custom domain", () => {
    expect(() => parseOnboardingChannels({
      customDomainPreference: "connect",
      telegramEnabled: true,
      websiteEnabled: false,
    })).toThrow(expect.objectContaining({ issues: ["custom_domain_requires_website"] }));
  });

  it("rejects client-controlled fields outside the channel contract", () => {
    expect(() => parseOnboardingChannels({
      customDomainPreference: "skip",
      ready: true,
      telegramEnabled: true,
      websiteEnabled: false,
    })).toThrow(expect.objectContaining({ issues: ["unknown_field:ready"] }));
  });

  it("accepts seller attestation against the published platform policy version", () => {
    expect(CURRENT_POLICY_ATTESTATION_VERSION).toBe(1);
    expect(parseOnboardingSettings({
      attestationAccepted: true,
      attestationVersion: 1,
      privacyUrl: "https://seller.example/privacy",
      refundPolicyUrl: "https://seller.example/refunds",
      supportContact: "  support@example.com  ",
      termsUrl: "https://seller.example/terms",
    })).toEqual({
      attestationAccepted: true,
      attestationVersion: 1,
      privacyUrl: "https://seller.example/privacy",
      refundPolicyUrl: "https://seller.example/refunds",
      supportContact: "support@example.com",
      termsUrl: "https://seller.example/terms",
    });
  });

  it("normalizes seller policy links without inventing an attestation", () => {
    expect(parseOnboardingSettings({
      attestationAccepted: false,
      attestationVersion: null,
      privacyUrl: "https://seller.example/privacy",
      refundPolicyUrl: "https://seller.example/refunds",
      supportContact: "  support@example.com  ",
      termsUrl: "https://seller.example/terms",
    })).toEqual({
      attestationAccepted: false,
      attestationVersion: null,
      privacyUrl: "https://seller.example/privacy",
      refundPolicyUrl: "https://seller.example/refunds",
      supportContact: "support@example.com",
      termsUrl: "https://seller.example/terms",
    });
  });

  it.each([
    ["http://seller.example/terms", "terms_url_invalid"],
    ["https://user:password@seller.example/terms", "terms_url_invalid"],
    ["https://seller.example/terms#secret", "terms_url_invalid"],
  ])("rejects unsafe policy URL %s", (termsUrl, issue) => {
    expect(() => parseOnboardingSettings({
      attestationAccepted: false,
      attestationVersion: null,
      privacyUrl: "https://seller.example/privacy",
      refundPolicyUrl: "https://seller.example/refunds",
      supportContact: "support@example.com",
      termsUrl,
    })).toThrow(expect.objectContaining({ issues: [issue] }));
  });

  it("clears attestation only with an explicit null version", () => {
    expect(parseOnboardingSettings({
      attestationAccepted: false,
      attestationVersion: null,
      privacyUrl: "",
      refundPolicyUrl: "",
      supportContact: "",
      termsUrl: "",
    })).toEqual({
      attestationAccepted: false,
      attestationVersion: null,
      privacyUrl: null,
      refundPolicyUrl: null,
      supportContact: null,
      termsUrl: null,
    });
  });
});
