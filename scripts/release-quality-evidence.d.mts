export interface ReleaseQualityEvidenceOptions {
  evidencePath: string;
  json: boolean;
  write: boolean;
}

export function parseArguments(argv: string[]): ReleaseQualityEvidenceOptions;
export function runReleaseQualityEvidence(
  options: ReleaseQualityEvidenceOptions,
  dependencies?: Record<string, any>,
): Promise<{
  artifactSha256: string;
  environment: "production";
  evidenceRef: string;
  mode: "validated" | "written";
  ok: true;
}>;
