export interface QualityStep {
  args: string[];
  command: string;
  key: string;
}

export interface CandidateState {
  commitSha: string;
  dirty: string;
  treeSha: string;
}

export interface ReleaseQualityArtifact {
  commitSha: string;
  environment: "production";
  evidence: Record<string, boolean | number>;
  mode: "quality_evidence";
  observedAt: string;
  releaseId: string;
  schemaVersion: 1;
  treeSha: string;
  workerVersion: string;
}

export interface CollectedQualityEvidence {
  artifact: ReleaseQualityArtifact | Record<string, unknown>;
  artifactSha256: string;
  evidenceRef: string;
  quality: Record<string, boolean | number | string>;
}

export const QUALITY_COMMANDS: readonly QualityStep[];
export function readQualityCandidateState(root?: string): CandidateState;
export function collectReleaseQualityEvidence(input?: {
  evidence?: any;
  now?: Date;
  readCandidateStateImplementation?: (root?: string) => CandidateState;
  repositoryRoot?: string;
  runCommandImplementation?: (step: QualityStep) => void | Promise<void>;
}): Promise<CollectedQualityEvidence>;
export function writeReleaseQualityEvidence(input?: {
  collected?: CollectedQualityEvidence;
  evidence?: any;
  evidencePath?: string;
  readCandidateStateImplementation?: (root?: string) => CandidateState;
  repositoryRoot?: string;
}): Promise<{ artifactSha256: string; evidenceRef: string }>;
