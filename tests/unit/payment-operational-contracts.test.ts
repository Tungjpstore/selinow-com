import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("payment operational contracts", () => {
  it("keeps the canonical Dodo route and PayOS attestation in runtime bindings", () => {
    const route = readFileSync("src/pages/api/webhooks/billing/dodo/[webhookPublicId].ts", "utf8");
    const bindings = readFileSync("src/lib/platform/bindings.ts", "utf8");
    expect(route).toContain("processDodoWebhookRequest");
    expect(bindings).toContain("PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT?: string");
  });

  it("keeps provider mutation commands dry-run and secret-free by default", () => {
    const dodo = execFileSync(process.execPath, ["scripts/dodo-webhook-register.mjs", "--env=staging"], { encoding: "utf8" });
    const payos = execFileSync(process.execPath, ["scripts/payos-staging-attest.mjs"], { encoding: "utf8" });
    expect(dodo).toContain("would_register_and_store_signing_key");
    expect(payos).toContain("would_attest_controlled_staging_channel");
    expect(`${dodo}${payos}`).not.toMatch(/whsec_|Bearer |client[_-]?id/iu);
  });
});
