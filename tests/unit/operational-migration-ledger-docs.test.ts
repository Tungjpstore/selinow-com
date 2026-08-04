import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const operationalDocs = [
  "docs/RELEASE.md",
  "docs/PRODUCTION_MUTATION_REVIEW_PACKAGE.md",
  "docs/PRODUCTION_RELEASE.md",
  "docs/PROVIDER_GATE_AUDIT.md",
  "docs/RUNBOOKS.md",
  "docs/DATA_MODEL.md",
  "docs/DOMAINS.md",
  "docs/IMPLEMENTATION_STATUS.md",
] as const;
const content = Object.fromEntries(operationalDocs.map((path) => [path, readFileSync(path, "utf8")]));

describe("operational migration-ledger documentation", () => {
  it("keeps current operational sections on the complete 0080 source chain", () => {
    expect(content["docs/RELEASE.md"]).toContain("source tree is now `0001`-`0080`");
    expect(content["docs/RELEASE.md"]).toContain("52 pending migrations `0029`-`0080`");
    expect(content["docs/PRODUCTION_MUTATION_REVIEW_PACKAGE.md"]).toContain("Exact pending migrations: `0053`-`0080`");
    expect(content["docs/PRODUCTION_RELEASE.md"]).toContain("explicit `releaseScope`");
    expect(content["docs/PRODUCTION_RELEASE.md"]).toContain("reviewed live `migrationLedgerPrefix`");
    expect(content["docs/PROVIDER_GATE_AUDIT.md"]).toContain("source has the contiguous forward-only chain through `0080`");
    expect(content["docs/RUNBOOKS.md"]).toContain("complete `0029`-`0080` chain");
    expect(content["docs/DATA_MODEL.md"]).toContain("authoritative numbered source chain is contiguous through `0080_catalog_activation_timestamps.sql`");
    expect(content["docs/IMPLEMENTATION_STATUS.md"]).toContain("authoritative source migration chain is contiguous through `0080`");
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
