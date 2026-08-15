import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const candidate = "bff69f9d26a04b1318fd9862afa6eaffb8c003f4";
const blocker = "phase_5_read_only_evidence_unavailable";
const statuses = [
  "not_started",
  "pending_user",
  "waiting_provider",
  "projection_unavailable",
  "passed",
  "failed",
  "stopped",
  "reconciled",
] as const;
const scenarios = [
  "exact_payment", "duplicate_webhook", "partial_payment", "overpaid_payment",
  "late_payment", "mismatched_payment", "inventory_race", "fulfillment_replay",
  "provider_outage", "stale_readiness", "shop_switch_inventory_request",
  "billing_response_loss", "support_escalation", "rollback_cleanup",
  "tenant_isolation", "migration_retry", "deploy_response_ambiguity",
  "monitoring_acknowledgement_loss",
] as const;
const p5Artifacts = [
  "docs/PHASE_5_REVIEW_PACKAGE_R0.md",
  "docs/PHASE_5_STAGING_EXECUTION.md",
  "docs/PHASE_5_UAT_RESULTS.md",
  "docs/PHASE_5_PILOT_ADMISSION.md",
  "docs/PHASE_5_INCIDENT_LOG.md",
  "infra/release/phase-5-pilot-scorecard.example.json",
] as const;
const historicalP4Artifacts = [
  "docs/PHASE_4_STAGING_ACCEPTANCE.md",
  "docs/PHASE_4_UAT_MATRIX.md",
  "docs/PHASE_4_PILOT_EXECUTION_PLAN.md",
  "docs/PHASE_4_INCIDENT_AND_ROLLBACK.md",
] as const;

describe("Phase 5 evidence contracts", () => {
  it("keeps the current state blocked when durable read-only evidence is absent", () => {
    for (const path of p5Artifacts) expect(existsSync(path), path).toBe(true);

    const review = readFileSync(p5Artifacts[0], "utf8");
    expect(review).toContain(candidate);
    expect(review).toContain("Status: `staging_execution_blocked`");
    expect(review).toContain(blocker);
    expect(review).toContain("timestamped mode-`0600` report");
    expect(review).toContain("Git records only its private path and SHA-256 checksum");
    expect(review).not.toContain("Fresh read-only `platform:doctor` authenticated");
    expect(review).not.toContain("Fresh read-only database preflight passed");

    const current = readFileSync("docs/CURRENT_STATE.md", "utf8");
    expect(current).toContain("P5 status: `staging_execution_blocked`");
    expect(current).toContain(blocker);
    expect(current).not.toContain("P5 status: `staging_accepted_pilot_not_started`");
    expect(current).not.toContain("P5 status: `pilot_ready`");

    const implementation = readFileSync("docs/IMPLEMENTATION_STATUS.md", "utf8");
    expect(implementation).toContain(blocker);
    expect(implementation).not.toContain("Fresh read-only admission authenticated");
  });

  it("requires every remote staging stage to remain blocked or not started", () => {
    const execution = readFileSync(p5Artifacts[1], "utf8");
    for (const stage of [
      "Read-only admission report",
      "Staging account/resource doctor",
      "Exact D1 UUID admission",
      "Direct ordered live ledger proof",
      "Database preflight",
      "Route/domain/SaaS inventory",
      "Worker current/previous version",
      "Monitoring/owners/window",
    ]) {
      expect(execution).toContain(`| ${stage} | \`blocked\` |`);
    }
    for (const stage of [
      "Protected staging backup/restore",
      "Schema-3 release manifest",
      "Migration",
      "Deploy",
      "Smoke",
    ]) {
      expect(execution).toContain(`| ${stage} | \`not_started\` |`);
    }
    expect(execution).not.toContain("`passed` | all available staging checks");
  });

  it("keeps the Phase 5 scorecard exact, non-evidence, and safely blocked", () => {
    const template = JSON.parse(readFileSync(p5Artifacts[5], "utf8")) as {
      candidateCommit: null;
      candidateTree: null;
      exampleOnly: boolean;
      overallStatus: string;
      readOnlyAdmissionReportRef: null;
      readOnlyAdmissionReportSha256: null;
      releaseId: null;
      scenarios: Record<string, { evidenceRef: string | null; ownerAckRef: string | null; status: string }>;
    };
    expect(template.exampleOnly).toBe(true);
    expect(template.candidateCommit).toBeNull();
    expect(template.candidateTree).toBeNull();
    expect(template.releaseId).toBeNull();
    expect(template.readOnlyAdmissionReportRef).toBeNull();
    expect(template.readOnlyAdmissionReportSha256).toBeNull();
    expect(template.overallStatus).toBe("not_started");
    expect(Object.keys(template.scenarios).sort()).toEqual([...scenarios].sort());
    expect(Object.values(template.scenarios).every(({ evidenceRef, ownerAckRef, status }) => (
      evidenceRef === null
      && ownerAckRef === null
      && statuses.includes(status as typeof statuses[number])
    ))).toBe(true);
    expect(Object.values(template.scenarios).some(({ status }) => (
      status === "passed" || status === "reconciled"
    ))).toBe(false);
  });

  it("keeps UAT results aligned with the machine scorecard", () => {
    const uat = readFileSync(p5Artifacts[2], "utf8");
    const template = JSON.parse(readFileSync(p5Artifacts[5], "utf8")) as {
      scenarios: Record<string, { status: string }>;
    };
    const rows: Record<string, string> = {};
    for (const match of uat.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gmu)) {
      const scenario = match[1];
      const status = match[2];
      if (scenario === undefined || status === undefined) throw new Error("phase_5_uat_row_invalid");
      rows[scenario] = status;
    }
    expect(rows).toEqual(Object.fromEntries(
      Object.entries(template.scenarios).map(([scenario, value]) => [scenario, value.status]),
    ));
    expect(uat).toContain("Score: 0 passed, 0 failed, 11 not started, 2 waiting provider, and 5 pending");
    expect(uat).not.toContain("`passed`");
    expect(uat).not.toContain("`reconciled`");
  });

  it("keeps P5 artifacts free of secret, PII, and plaintext inventory fields", () => {
    const content = p5Artifacts.map((path) => readFileSync(path, "utf8")).join("\n").toLowerCase();
    for (const forbidden of [
      "sessiontoken", "csrftoken", "webhooksecret", "webhooksignature", "rawbody",
      "bottoken", "apikey", "providercredential", "paymenturl", "licenseplaintext",
      "privateobjectkey", "rawinventory",
    ]) {
      expect(content).not.toContain(`"${forbidden}"`);
    }
  });

  it("does not rewrite historical Phase 4 contracts with Phase 5 execution state", () => {
    for (const path of historicalP4Artifacts) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("P5 execution note");
      expect(content).not.toContain("PHASE_5_");
      expect(content).not.toContain("staging_execution_blocked");
    }
  });
});
