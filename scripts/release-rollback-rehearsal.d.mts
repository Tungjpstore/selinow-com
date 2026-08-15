export function parseArguments(argv: string[]): {
  confirmMaintenanceDrain: boolean;
  confirmProduction: boolean;
  evidencePath: string;
  execute: boolean;
  json: boolean;
  maintenanceDrainEvidencePath: string | null;
  smokeStorefrontUrl: string | null;
  write: boolean;
};

export function smokeRollbackCanary(input: {
  apiBaseUrl?: string;
  dashboardUrl?: string;
  fetcher?: typeof fetch;
  marketingUrl?: string;
  storefrontUrl: string;
  webhookPublicId: string;
}): Promise<{
  checks: string[];
  status: "passed";
}>;

export function verifyMaintenanceDrainEvidence(input: {
  evidence: Record<string, any>;
  evidencePath: string;
  now?: Date;
  repositoryRoot?: string;
}): Promise<{
  observedAt: string;
}>;

export function executeProductionRollbackRehearsal(input: Record<string, any>): Promise<{
  artifact: Record<string, any>;
  artifactSha256: string;
  evidenceRef: string;
}>;

export function runProductionRollbackRehearsal(
  options: ReturnType<typeof parseArguments>,
  dependencies?: Record<string, any>,
): Promise<{
  authorizesProductionAdmission: boolean;
  artifactSha256: string;
  environment: "production";
  evidenceRef: string;
  mode: "live_rollback_rehearsal" | "schema_compatibility_validation";
  ok: true;
}>;
