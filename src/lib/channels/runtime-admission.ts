import { getProviderRuntimeContract } from "./provider-contracts";
import { requireChannelExpansion } from "./expansion";
import type { ChannelCapability, ChannelConnectionHealth, ChannelCredentialStatus } from "./types";

export type ProviderRuntimeAdmissionReason =
  | "connection_not_active"
  | "credential_not_active"
  | "provider_identity_unverified"
  | "provider_contract_pending"
  | "required_capability_missing"
  | "webhook_evidence_missing"
  | "webhook_evidence_stale";

export type ProviderRuntimeAdmission = {
  code: string;
  reasons: readonly ProviderRuntimeAdmissionReason[];
  status: "blocked" | "ready";
};

const DEFAULT_WEBHOOK_EVIDENCE_TTL_MS = 15 * 60 * 1_000;

/**
 * Computes the effective provider gate without mutating D1 or exposing
 * credentials. A connector request and a provider manifest are not enough to
 * make a channel executable.
 */
export function evaluateProviderRuntimeAdmission(input: {
  code: string;
  connectionStatus: ChannelConnectionHealth;
  credentialStatus: ChannelCredentialStatus | null;
  now?: Date;
  providerIdentityMatched: boolean;
  requiredCapabilities?: readonly ChannelCapability[];
  grantedCapabilities: ReadonlySet<ChannelCapability>;
  webhookVerifiedAt: string | null;
  webhookEvidenceTtlMs?: number;
}): ProviderRuntimeAdmission {
  const contract = getProviderRuntimeContract(input.code);
  const reasons = new Set<ProviderRuntimeAdmissionReason>();
  const now = input.now ?? new Date();
  const ttl = input.webhookEvidenceTtlMs ?? DEFAULT_WEBHOOK_EVIDENCE_TTL_MS;

  if (requireChannelExpansion(contract.code).providerExecution === "provider_pending") reasons.add("provider_contract_pending");
  if (input.connectionStatus !== "active") reasons.add("connection_not_active");
  if (input.credentialStatus !== "active") reasons.add("credential_not_active");
  if (!input.providerIdentityMatched) reasons.add("provider_identity_unverified");

  if (input.webhookVerifiedAt === null) {
    reasons.add("webhook_evidence_missing");
  } else {
    const verifiedAt = Date.parse(input.webhookVerifiedAt);
    if (!Number.isFinite(verifiedAt) || !Number.isFinite(now.getTime()) || !Number.isSafeInteger(ttl) || ttl < 60_000 || now.getTime() - verifiedAt > ttl || verifiedAt - now.getTime() > 30_000) {
      reasons.add("webhook_evidence_stale");
    }
  }

  for (const capability of input.requiredCapabilities ?? []) {
    if (!input.grantedCapabilities.has(capability)) reasons.add("required_capability_missing");
  }

  return Object.freeze({
    code: contract.code,
    reasons: Object.freeze([...reasons]),
    status: reasons.size === 0 ? "ready" : "blocked",
  });
}
