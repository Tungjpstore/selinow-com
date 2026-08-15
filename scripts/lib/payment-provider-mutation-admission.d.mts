export function buildPaymentMutationChildEnvironment(environment: NodeJS.ProcessEnv, accountId: string): NodeJS.ProcessEnv;
export function assertDodoCanonicalRouteProbe(response: Response, payload: unknown, requestId: string): void;
export function assertPaymentProviderMutationAdmission(input: {
  environment: "production" | "staging";
  manifestPath: string;
  operatorEnvironment?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
  stagingReleaseAdmissionImplementation?: (input: Record<string, unknown>) => Promise<{ commitSha: string; releaseId: string }>;
  productionReleaseAdmissionImplementation?: (input: Record<string, unknown>) => Promise<{ commitSha: string; releaseId: string }>;
  stagingMutationAdmissionImplementation?: (input: Record<string, unknown>) => Promise<{ accountId: string; ok: true; workerName: string }>;
  productionWorkerAdmissionImplementation?: (input: Record<string, unknown>) => Promise<{ accountId: string; ok: true; workerName: string }>;
}): Promise<{
  accountId: string;
  childEnvironment: NodeJS.ProcessEnv;
  commitSha: string;
  releaseId: string;
  workerName: string;
}>;
