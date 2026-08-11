export function parseArguments(argv: string[]): {
  confirmMaintenanceDrain: boolean;
  confirmProduction: boolean;
  evidencePath: string;
  execute: boolean;
  json: boolean;
  write: boolean;
};

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
