import { describe, expect, it } from "vitest";

import {
  loadPaymentProviderReadiness,
  projectLegacyPayOSReadiness,
  projectPaymentProviderReadiness,
  type PaymentCapabilityReadiness,
  type PaymentProviderConnectionReadiness,
  type PaymentSupportReadiness,
} from "../../src/lib/payments/readiness";
import { definePaymentProviderDescriptor } from "../../src/lib/payments/provider";

const CHECKED_AT = "2026-07-29T06:00:00.000Z";
const FRESH = "2026-07-29T05:30:00.000Z";
const STALE = "2026-07-27T05:30:00.000Z";

const descriptor = definePaymentProviderDescriptor({
  capabilities: ["checkout.create", "credential.health", "payment.reconcile", "webhook.verify"],
  code: "acmepay",
  connectionModes: ["bring_your_own", "managed"],
  settlementMode: "direct",
  supportedCurrencies: ["EUR", "USD"],
  supportedPaymentMethods: ["card", "wallet"],
});

const morDescriptor = definePaymentProviderDescriptor({
  ...descriptor,
  code: "acmemor",
  connectionModes: ["managed"],
  settlementMode: "mor_partner",
});

function connection(change: Partial<PaymentProviderConnectionReadiness> = {}): PaymentProviderConnectionReadiness {
  return {
    capabilityPolicyVersion: 1,
    connectionMode: "bring_your_own",
    credentialOwnership: "seller",
    lastCheckedAt: FRESH,
    lastWebhookVerifiedAt: FRESH,
    merchantCountryCode: "JP",
    providerAccountVerified: true,
    providerAttestedCountryCode: "JP",
    providerCode: "acmepay",
    providerDescriptorVersion: 1,
    providerEnvironment: "sandbox",
    settlementMode: "direct",
    shopId: "shop-a",
    status: "active",
    webhookStatus: "verified",
    ...change,
  };
}

function capabilities(change: Partial<PaymentCapabilityReadiness> = {}): PaymentCapabilityReadiness[] {
  return descriptor.capabilities.map((capabilityCode) => ({
    capabilityCode,
    capabilityPolicyVersion: 1,
    effectiveEnabled: true,
    providerGranted: true,
    providerDescriptorVersion: 1,
    ...change,
  }));
}

function support(codes: readonly string[], change: Partial<PaymentSupportReadiness> = {}): PaymentSupportReadiness[] {
  return codes.map((code) => ({
    capabilityPolicyVersion: 1,
    code,
    effectiveEnabled: true,
    providerSupported: true,
    providerDescriptorVersion: 1,
    ...change,
  }));
}

function project(change: Partial<Parameters<typeof projectPaymentProviderReadiness>[0]> = {}) {
  return projectPaymentProviderReadiness({
    capabilityRows: capabilities(),
    checkedAt: CHECKED_AT,
    connection: connection(),
    currency: "USD",
    descriptors: [descriptor],
    method: "card",
    planEntitlements: descriptor.capabilities,
    providerCode: "acmepay",
    providerSupportedCountries: ["JP", "US"],
    supportCurrencyRows: support(descriptor.supportedCurrencies),
    supportMethodRows: support(descriptor.supportedPaymentMethods),
    tenantShopId: "shop-a",
    ...change,
  });
}

describe("provider-neutral payment readiness projection", () => {
  it("recomputes effective support from descriptor, grants, plan, policy, health and commerce context", () => {
    const result = project({
      policyBlockedCapabilities: ["payment.reconcile"],
    });

    expect(result).toEqual({
      configured: true,
      connectionStatus: "active",
      effectiveCapabilities: ["checkout.create", "credential.health", "webhook.verify"],
      effectiveCurrencies: ["EUR", "USD"],
      effectivePaymentMethods: ["card", "wallet"],
      healthFresh: true,
      providerCode: "acmepay",
      ready: true,
      reasons: [],
      registered: true,
      webhookFresh: true,
      webhookStatus: "verified",
    });
  });

  it("rejects platform-owned direct settlement even when managed mode is otherwise permitted", () => {
    const result = project({
      connection: connection({ connectionMode: "managed", credentialOwnership: "platform" }),
      permittedConnectionModes: ["managed"],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("settlement_policy_unsupported");
    expect(result.effectiveCapabilities).toEqual([]);
    expect(result.effectiveCurrencies).toEqual([]);
    expect(result.effectivePaymentMethods).toEqual([]);
  });

  it("preserves managed provider-partner merchant-of-record readiness", () => {
    const result = project({
      connection: connection({
        connectionMode: "managed",
        credentialOwnership: "provider_partner",
        providerCode: morDescriptor.code,
        settlementMode: "mor_partner",
      }),
      descriptors: [morDescriptor],
      permittedConnectionModes: ["managed"],
      providerCode: morDescriptor.code,
    });

    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it.each([
    ["missing", { connection: null }, "missing_connection"],
    ["stale", { connection: connection({ lastCheckedAt: STALE }) }, "health_stale"],
    ["degraded", { connection: connection({ status: "degraded" }) }, "connection_degraded"],
    ["unregistered", { descriptors: [] }, "provider_unregistered"],
    ["cross tenant", { tenantShopId: "shop-b" }, "tenant_mismatch"],
    ["unsupported country", { providerSupportedCountries: ["US"] }, "country_unsupported"],
    ["unverified provider country", {
      connection: connection({ providerAttestedCountryCode: null }),
    }, "provider_country_unverified"],
    ["unverified provider account", {
      connection: connection({ providerAccountVerified: false }),
    }, "provider_account_unverified"],
    ["unknown provider environment", {
      connection: connection({ providerEnvironment: "unknown" }),
    }, "provider_environment_invalid"],
    ["stale descriptor version", {
      capabilityRows: capabilities({ providerDescriptorVersion: 2 }),
    }, "projection_version_mismatch"],
    ["unsupported mode", {
      connection: connection({ connectionMode: "managed", credentialOwnership: "platform" }),
      permittedConnectionModes: ["bring_your_own"],
    }, "mode_unsupported"],
    ["unsupported currency", { currency: "JPY" }, "currency_unsupported"],
    ["unsupported method", { method: "bank_transfer_qr" }, "method_unsupported"],
  ] as const)("fails closed for %s readiness", (_label, change, reason) => {
    const result = project(change);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("removes revoked, unentitled and policy-blocked capabilities before readiness", () => {
    const revoked = capabilities().map((row) => row.capabilityCode === "webhook.verify"
      ? { ...row, revokedAt: FRESH }
      : row);
    const revokedResult = project({ capabilityRows: revoked });
    expect(revokedResult.ready).toBe(false);
    expect(revokedResult.reasons).toContain("capability_revoked");
    expect(revokedResult.effectiveCapabilities).not.toContain("webhook.verify");

    const planResult = project({ planEntitlements: ["checkout.create", "credential.health", "payment.reconcile"] });
    expect(planResult.ready).toBe(false);
    expect(planResult.reasons).toContain("capability_plan_unentitled");

    const policyResult = project({ policyBlockedCapabilities: ["webhook.verify"] });
    expect(policyResult.ready).toBe(false);
    expect(policyResult.reasons).toContain("capability_policy_blocked");
  });

  it("returns only redacted operational state", () => {
    const json = JSON.stringify(project());
    expect(json).not.toContain("shop-a");
    expect(json).not.toContain("credential-secret-value");
    expect(json).not.toContain("fingerprint");
    expect(json).not.toContain("evidence");
    expect(json).not.toContain("connectionId");
  });

  it("keeps the legacy PayOS readiness result behavior-equivalent", () => {
    const healthy = projectLegacyPayOSReadiness({
      checkedAt: CHECKED_AT,
      lastCheckedAt: FRESH,
      lastWebhookVerifiedAt: FRESH,
      status: "active",
      webhookStatus: "verified",
    });
    const stale = projectLegacyPayOSReadiness({
      checkedAt: CHECKED_AT,
      lastCheckedAt: STALE,
      lastWebhookVerifiedAt: FRESH,
      status: "active",
      webhookStatus: "verified",
    });
    const errored = projectLegacyPayOSReadiness({
      checkedAt: CHECKED_AT,
      lastCheckedAt: FRESH,
      lastWebhookVerifiedAt: FRESH,
      status: "error",
      webhookStatus: "verified",
    });

    expect(healthy.ready).toBe(true);
    expect(stale.ready).toBe(false);
    expect(errored.ready).toBe(false);
    expect(errored.connectionStatus).toBe("degraded");
  });
});

describe("payment readiness D1 projection", () => {
  it("uses tenant-leading predicates and omits connection identity from output", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const database = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          all: () => {
            if (sql.includes("connection_capabilities")) return Promise.resolve({ results: capabilities() });
            if (sql.includes("connection_currencies")) return Promise.resolve({ results: support(descriptor.supportedCurrencies) });
            return Promise.resolve({ results: support(descriptor.supportedPaymentMethods) });
          },
          bind(...bound: unknown[]) {
            values = bound;
            calls.push({ sql, values });
            return statement;
          },
          first: () => Promise.resolve({
            ...connection(),
            id: "connection-private-id",
          }),
        };
        return statement;
      },
    };

    const result = await loadPaymentProviderReadiness({
      checkedAt: CHECKED_AT,
      currency: "USD",
      descriptors: [descriptor],
      env: { PLATFORM_DB: database as unknown as D1Database },
      method: "card",
      planEntitlements: descriptor.capabilities,
      providerCode: "acmepay",
      providerSupportedCountries: ["JP"],
      shopId: "shop-a",
    });

    expect(result.ready).toBe(true);
    expect(JSON.stringify(result)).not.toContain("connection-private-id");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.sql.includes("shop_id = ?"))).toBe(true);
    expect(calls.every((call) => call.values[0] === "shop-a")).toBe(true);
  });

  it("fails closed without leaking database errors", async () => {
    const result = await loadPaymentProviderReadiness({
      descriptors: [descriptor],
      env: {
        PLATFORM_DB: {
          prepare: () => {
            throw new Error("secret credential value");
          },
        } as unknown as D1Database,
      },
      planEntitlements: descriptor.capabilities,
      providerCode: "acmepay",
      providerSupportedCountries: ["JP"],
      shopId: "shop-a",
    });

    expect(result).toMatchObject({ ready: false, reasons: ["projection_invalid"] });
    expect(JSON.stringify(result)).not.toContain("secret credential value");
  });
});
