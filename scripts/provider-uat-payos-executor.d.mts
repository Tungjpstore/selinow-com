export type PayosProviderUatReceipt = {
  artifactRef: string;
  artifactSha256: string;
  authority: "payos_signed_webhook_or_verified_response";
  d1AfterSha256: string;
  d1BeforeSha256: string;
  d1TransitionSha256: string;
  executionTranscriptSha256: string;
  observedAt: string;
  provider: "payos";
  providerEventSha256: string;
  providerSignatureSha256: string;
  release: Record<string, string>;
  scenarioId: "direct_reconciliation" | "signed_exact_payment";
  schemaVersion: 1;
};

export function executePayosProviderUat(input: {
  environment?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  input: Record<string, unknown>;
  now?: () => Date;
  randomId?: () => string;
  repositoryRoot?: string;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<PayosProviderUatReceipt>;

export function main(): Promise<PayosProviderUatReceipt>;
