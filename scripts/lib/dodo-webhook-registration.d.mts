export function fingerprintDodoWebhookReference(scope: "endpoint" | "provider_webhook", value: string): string;

export function ensureDodoWebhook(input: {
  apiBaseUrl: string;
  apiKey: string;
  endpointUrl: string;
  fetcher: typeof fetch;
  /** Testable local serialization path; production defaults to a namespaced temp lease. */
  lockPath?: string;
  fileSystemHooks?: { beforeLeaseUnlink?: (input: { path: string }) => Promise<void> | void };
}): Promise<{
  created: boolean;
  endpointFingerprintSha256: string;
  providerWebhookFingerprintSha256: string;
  secret: string;
}>;
