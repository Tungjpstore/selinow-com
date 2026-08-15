import { describe, expect, it } from "vitest";

import { evaluateProviderRuntimeAdmission } from "../../src/lib/channels/runtime-admission";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function readyInput(overrides: Partial<Parameters<typeof evaluateProviderRuntimeAdmission>[0]> = {}) {
  return {
    code: "whatsapp.cloud",
    connectionStatus: "active" as const,
    credentialStatus: "active" as const,
    now: NOW,
    providerIdentityMatched: true,
    requiredCapabilities: ["conversation.outbound"] as const,
    grantedCapabilities: new Set(["conversation.outbound"] as const),
    webhookVerifiedAt: "2026-08-02T11:55:00.000Z",
    ...overrides,
  };
}

describe("provider runtime admission", () => {
  it("keeps coming-next providers blocked even when every local proof looks complete", () => {
    expect(evaluateProviderRuntimeAdmission(readyInput())).toEqual({
      code: "whatsapp.cloud",
      reasons: ["provider_contract_pending"],
      status: "blocked",
    });
    expect(evaluateProviderRuntimeAdmission(readyInput({ credentialStatus: "pending" }))).toMatchObject({
      status: "blocked",
      reasons: ["provider_contract_pending", "credential_not_active"],
    });
    expect(evaluateProviderRuntimeAdmission(readyInput({ providerIdentityMatched: false }))).toMatchObject({
      status: "blocked",
      reasons: ["provider_contract_pending", "provider_identity_unverified"],
    });
    expect(evaluateProviderRuntimeAdmission(readyInput({ webhookVerifiedAt: "2026-08-02T11:00:00.000Z" }))).toMatchObject({
      status: "blocked",
      reasons: ["provider_contract_pending", "webhook_evidence_stale"],
    });
  });

  it("keeps Zalo provider-pending even when local inputs look complete", () => {
    const admission = evaluateProviderRuntimeAdmission(readyInput({ code: "zalo.mini_app" }));
    expect(admission.status).toBe("blocked");
    expect(admission.reasons).toContain("provider_contract_pending");
  });

  it("blocks degraded connections and missing capabilities without exposing details", () => {
    const admission = evaluateProviderRuntimeAdmission(readyInput({
      connectionStatus: "degraded",
      grantedCapabilities: new Set(),
    }));
    expect(admission).toEqual({
      code: "whatsapp.cloud",
      reasons: ["provider_contract_pending", "connection_not_active", "required_capability_missing"],
      status: "blocked",
    });
    expect(JSON.stringify(admission)).not.toMatch(/token|secret|credential/i);
  });
});
