export type DodoUatReceipt = {
  artifactRef: string;
  artifactSha256: string;
  authority: string;
  d1AfterSha256: string;
  d1BeforeSha256: string;
  d1TransitionSha256: string;
  executionTranscriptSha256: string;
  observedAt: string;
  provider: "dodo";
  providerEventSha256: string | null;
  providerSignatureSha256: string | null;
  release: Record<string, string>;
  scenarioId: string;
  schemaVersion: 1;
};

export function runDodoUatExecutor(options?: {
  environment?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  inputStream?: AsyncIterable<Uint8Array | string>;
  now?: () => Date;
  repositoryRoot?: string;
}): Promise<DodoUatReceipt>;
