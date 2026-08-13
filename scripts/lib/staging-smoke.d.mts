export interface StagingPhaseASmokePlan {
  checks: Array<{
    bodyMarker?: string;
    contentType: "any" | "html" | "json" | "text";
    expectedStatuses: number[];
    kind: string;
    method: "GET" | "HEAD";
    name: string;
    requiredHeaders: string[];
    requiredHeaderValues?: Record<string, string>;
    url: string;
  }>;
  environment: "staging";
  readOnly: true;
}

export function createStagingPhaseASmokePlan(spec: Record<string, unknown>): StagingPhaseASmokePlan;
export function validateStagingPhaseASmokePlan(plan: unknown): StagingPhaseASmokePlan;
export function runStagingPhaseASmoke(input: {
  fetchImplementation?: typeof fetch;
  plan: unknown;
}): Promise<{
  actions: Array<{ code: string; name: string; ok: boolean; status?: number }>;
  environment: "staging";
  ok: boolean;
  readOnly: true;
}>;
