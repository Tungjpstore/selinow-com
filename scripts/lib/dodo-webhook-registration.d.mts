export function fingerprintDodoWebhookReference(scope: "endpoint" | "provider_webhook", value: string): string;

export function ensureDodoWebhook(input: {
  apiBaseUrl: string;
  apiKey: string;
  endpointUrl: string;
  fetcher: typeof fetch;
}): Promise<{
  created: boolean;
  endpointFingerprintSha256: string;
  providerWebhookFingerprintSha256: string;
  secret: string;
}>;
