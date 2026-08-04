import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const candidate = "bff69f9d26a04b1318fd9862afa6eaffb8c003f4";
const artifactPaths = [
  "docs/PHASE_4_REVIEW_PACKAGE_R0.md",
  "docs/PHASE_4_STAGING_ACCEPTANCE.md",
  "docs/PHASE_4_UAT_MATRIX.md",
  "docs/PHASE_4_PILOT_EXECUTION_PLAN.md",
  "docs/PHASE_4_INCIDENT_AND_ROLLBACK.md",
  "infra/release/phase-4-pilot-scorecard.example.json",
  "docs/CURRENT_STATE.md",
  "docs/IMPLEMENTATION_STATUS.md",
  "docs/STAGING_MUTATION_REVIEW_PACKAGE.md",
] as const;
const statuses = ["not_started", "pending_user", "waiting_provider", "projection_unavailable", "passed", "failed", "stopped", "reconciled"] as const;
const scenarios = [
  "exact_payment", "duplicate_webhook", "partial_payment", "overpaid_payment",
  "late_payment", "mismatched_payment", "inventory_race", "fulfillment_replay",
  "provider_outage", "stale_readiness", "shop_switch_inventory_request",
  "billing_response_loss", "support_escalation", "rollback_cleanup",
  "tenant_isolation", "migration_retry", "deploy_response_ambiguity",
  "monitoring_acknowledgement_loss",
] as const;

describe("Phase 4 evidence contracts", () => {
  it("keeps every required artifact candidate-bound and locally blocked", () => {
    for (const path of artifactPaths) expect(existsSync(path), path).toBe(true);
    const review = readFileSync(artifactPaths[0], "utf8");
    expect(review).toContain(candidate);
    expect(review).toContain("local_ready_remote_blocked");
    expect(review).not.toContain("pilot_accepted");
    expect(review).not.toContain("staging_accepted_pilot_not_started");
    const current = readFileSync("docs/CURRENT_STATE.md", "utf8");
    expect(current).toContain("staging, providers, pilot, and production remain NO-GO");
    expect(current).toContain(`P4 implementation candidate \`${candidate}\``);
    expect(current).toContain("Phase 4 scorecard, safe evidence allowlist and 18-scenario regression map");
    expect(current).toContain("docs/PHASE_4_REVIEW_PACKAGE_R0.md");
    expect(current).not.toContain("This is the short current-state record for the Phase 3 staging-admission");
    expect(current).not.toContain("P3 implementation candidate `ec66a7a909319ac0a4b5b4b8c777836e636e56a5`");
    expect(current).not.toContain("Phase 3 scorecard, safe evidence allowlist and 14-scenario regression map");
    expect(current).not.toContain("P4 completion state: `pilot_accepted`");
    const mutationPackage = readFileSync("docs/STAGING_MUTATION_REVIEW_PACKAGE.md", "utf8");
    expect(mutationPackage).toContain("clean Phase 4 pilot candidate");
    expect(mutationPackage).toContain("docs/PHASE_4_REVIEW_PACKAGE_R0.md");
    expect(mutationPackage).toContain("schema version `3`");
    expect(mutationPackage).not.toContain("clean Phase 2 pilot candidate");
    expect(mutationPackage).not.toContain("Exact P3 changed-file manifest and local verification");
  });

  it("covers all scenarios and the exact status vocabulary without fake completion", () => {
    const template = JSON.parse(readFileSync(artifactPaths[5], "utf8")) as {
      candidateCommit: null;
      exampleOnly: boolean;
      overallStatus: string;
      scenarios: Record<string, { status: string }>;
    };
    expect(template.exampleOnly).toBe(true);
    expect(template.candidateCommit).toBeNull();
    expect(template.overallStatus).toBe("not_started");
    expect(Object.keys(template.scenarios).sort()).toEqual([...scenarios].sort());
    expect(Object.values(template.scenarios).every(({ status }) => statuses.includes(status as typeof statuses[number]))).toBe(true);
    expect(Object.values(template.scenarios).some(({ status }) => status === "passed" || status === "reconciled")).toBe(false);
  });

  it("maps every local test reference to a real file", () => {
    const matrix = readFileSync(artifactPaths[2], "utf8");
    for (const scenario of scenarios) expect(matrix).toContain(`\`${scenario}\``);
    const refs = [...matrix.matchAll(/`(tests\/[a-z0-9./-]+\.test\.ts)`/giu)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThanOrEqual(scenarios.length);
    for (const ref of new Set(refs)) expect(existsSync(ref ?? ""), ref).toBe(true);
  });

  it("defines monitor source, thresholds, window, owner, acknowledgement, and action", () => {
    const acceptance = readFileSync(artifactPaths[1], "utf8");
    for (const heading of ["Metric/source", "Warning threshold", "Stop threshold", "Window", "Owner", "Notification/ack reference", "Stop/rollback/reconciliation action"]) {
      expect(acceptance).toContain(heading);
    }
    for (const signal of ["Worker availability", "Worker latency", "D1 ambiguity", "Tenant isolation", "Exact payment", "Payment exceptions", "Inventory", "Fulfillment", "Queue/DLQ", "Provider health", "Secret/PII leakage", "Support acknowledgement", "Infrastructure budget"]) {
      expect(acceptance).toContain(`| ${signal} |`);
    }
  });

  it("keeps the machine template free of secret, PII, and plaintext inventory fields", () => {
    const template = readFileSync(artifactPaths[5], "utf8").toLowerCase();
    for (const forbidden of ["email", "phone", "address", "sessiontoken", "csrftoken", "webhooksecret", "webhooksignature", "rawbody", "bottoken", "apikey", "providercredential", "paymenturl", "licenseplaintext", "privateobjectkey", "rawinventory"]) {
      expect(template).not.toContain(`"${forbidden}"`);
    }
  });
});
