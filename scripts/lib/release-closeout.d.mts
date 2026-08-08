export interface ReleaseCloseoutCheck {
  name: string;
  ok: boolean;
  category: string;
  nextAction: string;
}

export interface ReleaseCloseoutManifest {
  path: string;
  releaseId: string | null;
  commitSha: string | null;
  treeSha: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  schemaVersion: unknown;
}

export interface ReleaseCloseoutReport {
  generatedAt: string;
  ok: boolean;
  summary: {
    failed: number;
    passed: number;
    total: number;
    categoryCounts: Record<string, { failed: number; passed: number }>;
  };
  repository: {
    headSha: string | null;
    treeSha: string | null;
    clean: boolean;
  };
  staging: {
    latestManifest: ReleaseCloseoutManifest | null;
    manifestCount: number;
    candidateMatchesLatestStaging: boolean;
  };
  failedChecks: ReleaseCloseoutCheck[];
  missing: string[];
}

export function classifyReleaseCheck(check: Record<string, unknown>): ReleaseCloseoutCheck;

export function buildCloseoutReport(input?: {
  evidence?: unknown;
  productionSpec?: unknown;
  workerSecretNames?: string[];
  wranglerConfig?: unknown;
  now?: Date;
  stagingReleaseRoot?: string;
}): Promise<ReleaseCloseoutReport>;

export function loadCloseoutInputs(input?: {
  evidencePath?: string;
  productionSpecPath?: string;
  secretNamesPath?: string | null;
  wranglerConfigPath?: string;
}): Promise<{
  evidence: unknown;
  productionSpec: unknown;
  workerSecretNames: string[];
  wranglerConfig: unknown;
}>;
