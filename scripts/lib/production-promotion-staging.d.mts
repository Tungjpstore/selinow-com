export type ProductionPromotionStagingSpec = Record<string, unknown> & {
  environment: string;
  sharedZoneDisabledRoutes: string[];
  zoneName: string;
};

export function deriveProductionPromotionStagingSpec(
  stagingSpec: ProductionPromotionStagingSpec,
): ProductionPromotionStagingSpec;

export function assertProductionPromotionStagingContract(
  stagingSpec: ProductionPromotionStagingSpec,
  promotionStagingSpec: ProductionPromotionStagingSpec,
): ProductionPromotionStagingSpec;
