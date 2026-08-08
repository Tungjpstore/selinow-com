import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertDodoCanonicalRouteProbe, buildPaymentMutationChildEnvironment } from "../../scripts/lib/payment-provider-mutation-admission.mjs";

describe("payment operational contracts", () => {
  it("keeps the canonical Dodo route and PayOS attestation in runtime bindings", () => {
    const route = readFileSync("src/pages/api/webhooks/billing/dodo/[webhookPublicId].ts", "utf8");
    const bindings = readFileSync("src/lib/platform/bindings.ts", "utf8");
    const registration = readFileSync("scripts/dodo-webhook-register.mjs", "utf8");
    expect(route).toContain("processDodoWebhookRequest");
    expect(bindings).toContain("PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT?: string");
    expect(registration.indexOf("assertPaymentProviderMutationAdmission")).toBeLessThan(registration.indexOf("ensureDodoWebhook({"));
    expect(registration.indexOf("assertDodoCanonicalRouteProbe")).toBeLessThan(registration.indexOf("ensureDodoWebhook({"));
  });

  it("keeps provider mutation commands dry-run and secret-free by default", () => {
    const dodo = execFileSync(process.execPath, ["scripts/dodo-webhook-register.mjs", "--env=staging"], { encoding: "utf8" });
    const payos = execFileSync(process.execPath, ["scripts/payos-staging-attest.mjs"], { encoding: "utf8" });
    expect(dodo).toContain("would_register_and_store_signing_key");
    expect(payos).toContain("would_attest_controlled_staging_channel");
    expect(`${dodo}${payos}`).not.toMatch(/whsec_|Bearer |client[_-]?id/iu);
    expect(readFileSync("scripts/lib/payment-provider-mutation-admission.mjs", "utf8")).toContain("CLOUDFLARE_PAYMENT_MUTATION_API_TOKEN");
  });

  it("pins the account and strips operator/provider secrets from Wrangler mutation env", () => {
    const child = buildPaymentMutationChildEnvironment({
      CLOUDFLARE_PAYMENT_MUTATION_API_TOKEN: "ephemeral-route-write-token",
      CLOUDFLARE_PLATFORM_API_TOKEN: "read-only-platform-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "read-only-route-token",
      DODO_PAYMENTS_API_KEY: "provider-secret",
      IDENTIFIER_HMAC_SECRET: "runtime-secret",
    }, "a".repeat(32));
    expect(child).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "ephemeral-route-write-token" });
    expect(child).not.toHaveProperty("CLOUDFLARE_PLATFORM_API_TOKEN");
    expect(child).not.toHaveProperty("CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
    expect(child).not.toHaveProperty("DODO_PAYMENTS_API_KEY");
    expect(child).not.toHaveProperty("IDENTIFIER_HMAC_SECRET");
  });

  it("accepts only the exact unsigned handler response contract", () => {
    const response = { redirected: false, status: 503, url: "https://api-staging.selinow.com/api/webhooks/billing/dodo/ddowh_test", headers: new Headers({ "Cache-Control": "private, no-store, max-age=0", "X-Request-Id": "dodo-webhook-probe-release" }) } as unknown as Response;
    expect(() => { assertDodoCanonicalRouteProbe(response, { code: "billing_provider_unavailable", ok: false, requestId: "dodo-webhook-probe-release" }, "dodo-webhook-probe-release"); }).not.toThrow();
    const redirected = { headers: response.headers, redirected: true, status: response.status, url: response.url } as unknown as Response;
    expect(() => { assertDodoCanonicalRouteProbe(redirected, { code: "billing_provider_unavailable", ok: false, requestId: "dodo-webhook-probe-release" }, "dodo-webhook-probe-release"); }).toThrow("dodo_webhook_route_contract_invalid");
  });
});
