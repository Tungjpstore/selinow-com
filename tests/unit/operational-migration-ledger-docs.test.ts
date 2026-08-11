import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const operationalDocs = [
  "docs/RELEASE.md",
  "docs/STAGING_MUTATION_REVIEW_PACKAGE.md",
  "docs/PHASE_4_STAGING_ACCEPTANCE.md",
  "docs/PRODUCTION_MUTATION_REVIEW_PACKAGE.md",
  "docs/PRODUCTION_CONTINUATION_GATE_AUDIT_2026-08-09.md",
  "docs/PRODUCTION_RELEASE_CLOSEOUT_2026-08-09.md",
  "docs/PRODUCTION_RELEASE.md",
  "docs/PROVIDER_GATE_AUDIT.md",
  "docs/RUNBOOKS.md",
  "docs/DATA_MODEL.md",
  "docs/DOMAINS.md",
  "docs/IMPLEMENTATION_STATUS.md",
  "docs/release/CURRENT_HANDOFF_2026-08-09.md",
] as const;
const content = Object.fromEntries(operationalDocs.map((path) => [path, readFileSync(path, "utf8")]));
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const productionEvidenceExample = JSON.parse(readFileSync("infra/release/production-evidence.example.json", "utf8")) as {
  treeSha?: string;
  quality?: Record<string, unknown>;
  rollback?: { candidate?: Record<string, unknown> };
};

describe("operational migration-ledger documentation", () => {
  it("keeps current operational sections on the complete 0094 source chain", () => {
    expect(content["docs/RELEASE.md"]).toContain("source tree is now `0001`-`0094`");
    expect(content["docs/RELEASE.md"]).toContain("retained staging evidence covers `0001`-`0090`");
    expect(content["docs/RELEASE.md"]).toContain("production remains at `0052` with `0053`-`0094` pending");
    expect(content["docs/PRODUCTION_MUTATION_REVIEW_PACKAGE.md"]).toContain("Exact pending migrations: `0053`-`0094`");
    expect(content["docs/PRODUCTION_RELEASE.md"]).toContain("explicit `releaseScope`");
    expect(content["docs/PRODUCTION_RELEASE.md"]).toContain("reviewed live `migrationLedgerPrefix`");
    expect(content["docs/PRODUCTION_RELEASE.md"]).toContain("Continuation migration admission (`0053`-`0094`)");
    expect(content["docs/PRODUCTION_RELEASE.md"]).toContain("npm run deploy -- --env production --confirm-production --release-manifest");
    expect(content["docs/PRODUCTION_RELEASE.md"]).toContain("`CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN`");
    expect(content["docs/PRODUCTION_RELEASE.md"]).toContain("active deployment and deployable-version inventories");
    expect(content["docs/PROVIDER_GATE_AUDIT.md"]).toContain("source has the contiguous forward-only chain through `0094`");
    expect(content["docs/RUNBOOKS.md"]).toContain("complete source ledger ends at `0094_shop_creation_admission.sql`");
    expect(content["docs/RUNBOOKS.md"]).toContain("npm run db:complete-release");
    expect(content["docs/RUNBOOKS.md"]).toContain("CLOUDFLARE_WORKER_DEPLOY_API_TOKEN");
    expect(content["docs/RUNBOOKS.md"]).toContain("restore:drill -- --env production --confirm-production --reviewed-commit");
    expect(content["docs/STAGING_MUTATION_REVIEW_PACKAGE.md"]).toContain("complete `0001`-`0094` ledger");
    expect(content["docs/PHASE_4_STAGING_ACCEPTANCE.md"]).toContain("`db:complete-release`");
    expect(content["docs/PRODUCTION_CONTINUATION_GATE_AUDIT_2026-08-09.md"]).toContain("`0053` through `0094`");
    expect(content["docs/PRODUCTION_RELEASE_CLOSEOUT_2026-08-09.md"]).toContain("release:worker:upload");
    expect(content["docs/DATA_MODEL.md"]).toContain("authoritative numbered source chain is contiguous through `0094_shop_creation_admission.sql`");
    expect(content["docs/DOMAINS.md"]).toContain("0093_custom_domain_turnstile_runtime_guard.sql");
    expect(content["docs/IMPLEMENTATION_STATUS.md"]).toContain("Current operational source migration chain: contiguous `0001`-`0094`");
    expect(content["docs/release/CURRENT_HANDOFF_2026-08-09.md"]).toContain("`0091`-`0094` over the retained `0090` staging ledger");
    expect(packageJson.scripts?.["db:complete-release"]).toBe("node scripts/db.mjs complete-release");
    expect(packageJson.scripts?.["release:rollback:rehearsal"]).toBe("node scripts/release-rollback-rehearsal.mjs");
    expect(packageJson.scripts?.["release:worker:upload"]).toBe("node scripts/release-worker-upload.mjs");
    expect(productionEvidenceExample.treeSha).toBeTruthy();
    expect(productionEvidenceExample.quality).toMatchObject({
      schemaVersion: 2,
      check: false,
      lint: false,
      tscNoEmit: false,
      test: false,
      build: false,
      buildStaging: false,
      auditHigh: false,
      deployDryRun: false,
      deployStagingDryRun: false,
      gitDiffCheck: false,
    });
    const rollbackCandidate = productionEvidenceExample.rollback?.candidate;
    expect(rollbackCandidate).toMatchObject({
      schemaVersion: 2,
      accepted: false,
      rehearsalPassed: false,
    });
    for (const key of [
      "workerVersion",
      "commitSha",
      "treeSha",
      "migrationName",
      "migrationLedgerSha256",
      "evidenceRef",
      "artifactSha256",
    ]) expect(typeof rollbackCandidate?.[key]).toBe("string");
  });

  it("allows checkpoint history but rejects stale current operational claims", () => {
    expect(content["docs/RELEASE.md"]).not.toContain("Current-chain note: the source tree is now `0001`-`0077`");
    expect(content["docs/PRODUCTION_MUTATION_REVIEW_PACKAGE.md"]).not.toContain("Exact pending migrations: `0053`-`0077`");
    expect(content["docs/PROVIDER_GATE_AUDIT.md"]).not.toContain("source has forward-only `0053`-`0077`");
    expect(content["docs/RUNBOOKS.md"]).not.toContain("for the current ledger that is the complete `0029`-`0077` chain");
    expect(content["docs/DATA_MODEL.md"]).not.toContain("The current numbered source chain extends through `0076_dodo_platform_price_provider.sql`");
    expect(content["docs/DOMAINS.md"]).toContain("Production platform routing is live");
    expect(content["docs/DOMAINS.md"]).not.toContain("Production platform handoff matrix (not live)");
    expect(content["docs/IMPLEMENTATION_STATUS.md"]).not.toContain("Current frontend slice deployment boundary | The PromptOS frontend kit is traffic-deployed on Worker version `6ca9c890");
  });
});
