import { isDeepStrictEqual } from "node:util";

/**
 * The promotion planner needs the shared-zone guards removed only from its
 * private release contract. Normal staging operations must keep those guards.
 */
export function deriveProductionPromotionStagingSpec(stagingSpec) {
  if (typeof stagingSpec !== "object" || stagingSpec === null || Array.isArray(stagingSpec)) {
    throw new Error("production_promotion_staging_contract_invalid");
  }
  return {
    ...stagingSpec,
    sharedZoneDisabledRoutes: [],
  };
}

export function assertProductionPromotionStagingContract(stagingSpec, promotionStagingSpec) {
  if (
    typeof stagingSpec !== "object"
    || stagingSpec === null
    || Array.isArray(stagingSpec)
    || stagingSpec.environment !== "staging"
    || typeof stagingSpec.zoneName !== "string"
    || !isDeepStrictEqual(
      stagingSpec.sharedZoneDisabledRoutes,
      [`${stagingSpec.zoneName}/*`, `*.${stagingSpec.zoneName}/*`],
    )
    || !isDeepStrictEqual(
      promotionStagingSpec,
      deriveProductionPromotionStagingSpec(stagingSpec),
    )
  ) {
    throw new Error("production_promotion_staging_contract_invalid");
  }
  return promotionStagingSpec;
}
