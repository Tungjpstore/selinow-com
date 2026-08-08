import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertProductionPromotionStagingContract,
  deriveProductionPromotionStagingSpec,
} from "../../scripts/lib/production-promotion-staging.mjs";

type StagingSpec = Record<string, unknown> & {
  environment: string;
  sharedZoneDisabledRoutes: string[];
  zoneName: string;
};

const stagingSpec = JSON.parse(
  readFileSync(new URL("../../infra/environments/staging.json", import.meta.url), "utf8"),
  ) as StagingSpec;
const promotionStagingSpec = JSON.parse(
  readFileSync(new URL("../../infra/release/production-promotion-staging.json", import.meta.url), "utf8"),
  ) as StagingSpec;
const derivePromotionSpec = deriveProductionPromotionStagingSpec;
const assertPromotionSpec = assertProductionPromotionStagingContract;

describe("production promotion staging contract", () => {
  it("derives the checked-in promotion spec without weakening normal staging guards", () => {
    expect(stagingSpec.sharedZoneDisabledRoutes).toEqual([
      "selinow.com/*",
      "*.selinow.com/*",
      "*/*",
    ]);
    expect(promotionStagingSpec).toEqual(derivePromotionSpec(stagingSpec));
    expect(promotionStagingSpec.sharedZoneDisabledRoutes).toEqual([]);
  });

  it("rejects a promotion spec that is not an exact staging derivation", () => {
    expect(() => assertPromotionSpec(
      stagingSpec,
      { ...promotionStagingSpec, workerName: "unapproved-worker" },
    )).toThrow("production_promotion_staging_contract_invalid");

    expect(() => assertPromotionSpec(
      { ...stagingSpec, sharedZoneDisabledRoutes: [] },
      promotionStagingSpec,
    )).toThrow("production_promotion_staging_contract_invalid");
  });
});
