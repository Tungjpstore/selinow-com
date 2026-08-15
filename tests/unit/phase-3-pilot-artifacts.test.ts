import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const readiness = readFileSync("docs/PHASE_3_STAGING_READINESS.md", "utf8");
const review = readFileSync("docs/PHASE_3_REVIEW_PACKAGE_R0.md", "utf8");
const scorecard = readFileSync("docs/PHASE_3_PILOT_SCORECARD.md", "utf8");

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
  "exact_payment",
  "duplicate_webhook",
  "partial_payment",
  "overpaid_payment",
  "late_payment",
  "mismatched_payment",
  "inventory_race",
  "fulfillment_replay",
  "provider_outage",
  "stale_readiness",
  "shop_switch_inventory_request",
  "billing_response_loss",
  "support_escalation",
  "rollback_cleanup",
] as const;

function scorecardTemplate(): Record<string, unknown> {
  const match = scorecard.match(/```json\n(?<json>[\s\S]*?)\n```/u);
  if (!match?.groups?.json) throw new Error("phase_3_scorecard_template_missing");
  return JSON.parse(match.groups.json) as Record<string, unknown>;
}

describe("Phase 3 pilot artifacts", () => {
  it("defines the complete status vocabulary without claiming pilot completion", () => {
    for (const status of statuses) expect(scorecard).toContain(`\`${status}\``);

    const template = scorecardTemplate();
    expect(template).toMatchObject({
      candidateCommit: null,
      environment: "staging",
      overallStatus: "not_started",
      schema: "phase_3_pilot_scorecard",
      schemaVersion: 1,
    });
    expect(scorecard).toContain("Overall pilot status: `not_started`");
    expect(review).toContain("Pilot: `not_started`");
  });

  it("covers every required pilot scenario in the template and evidence matrix", () => {
    const template = scorecardTemplate();
    const scenarioTemplate = template.scenarios as Record<string, unknown>;

    expect(Object.keys(scenarioTemplate).sort()).toEqual([...scenarios].sort());
    for (const scenario of scenarios) {
      expect(scorecard).toContain(`| \`${scenario}\` |`);
      expect(scenarioTemplate[scenario]).toEqual(expect.objectContaining({
        evidenceRefs: [],
        observedAt: null,
        reasonCodes: [],
        safeRequestRefs: [],
      }));
    }
  });

  it("maps each local regression reference to an existing repository artifact", () => {
    const references = [...scorecard.matchAll(/`((?:tests|docs)\/[a-z0-9./-]+\.(?:md|ts))`/giu)]
      .map((match) => match[1])
      .filter((reference): reference is string => reference !== undefined);

    expect(references.length).toBeGreaterThanOrEqual(18);
    for (const reference of new Set(references)) expect(existsSync(reference), reference).toBe(true);
  });

  it("defines thresholds, windows, owners, stop conditions and safe evidence boundaries", () => {
    for (const phrase of [
      "## Monitoring contract",
      "Warning threshold",
      "Stop threshold",
      "Evaluation window",
      "Accountable role",
      "## Observation windows",
      "## Stop and rollback conditions",
      "release owner",
      "data owner",
      "payment incident owner",
      "integration incident owner",
      "support owner",
      "finance/budget owner",
    ]) expect(readiness).toContain(phrase);

    expect(scorecard).toContain("## Evidence allowlist");
    expect(scorecard).toContain("Never record seller/buyer names");
    expect(scorecard).toContain("license-key plaintext");
    expect(scorecard).toContain("webhook secrets/signatures/bodies");
  });
});
