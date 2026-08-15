import { describe, expect, it, vi } from "vitest";

import {
  admitProviderVerificationEvidence,
  promoteProviderConnectionFromEvidence,
  recordProviderVerificationEvidence,
  reviewProviderVerificationEvidence,
} from "../../src/lib/channels/provider-verification-evidence";

const HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FUTURE = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const VERIFIED = new Date(Date.now() - 60 * 1_000).toISOString();

const contextRow = {
  channelStatus: "enabled",
  connectionStatus: "pending",
  credentialFingerprint: HASH,
  credentialId: "credential-001",
  credentialStatus: "pending",
  credentialVersion: 1,
  providerCode: "zalo.mini_app",
  shopId: "shop-001",
  shopStatus: "active",
  subscriptionState: "active",
  currentPeriodEnd: "2099-01-01T00:00:00.000Z",
};

type EvidenceFixture = {
  connectionId: string;
  credentialFingerprint: string;
  credentialVersion: number;
  evidenceReference: string;
  expiresAt: string;
  id: string;
  providerCode: string;
  providerIdentityFingerprint: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  safeMetadataJson: string;
  shopId: string;
  status: "observed" | "reviewed" | "rejected";
  verificationKind: "webhook" | "identity" | "capability";
  verifiedAt: string;
  version: number;
};

const evidenceRow: EvidenceFixture = {
  connectionId: "connection-001",
  credentialFingerprint: HASH,
  credentialVersion: 1,
  evidenceReference: HASH,
  expiresAt: FUTURE,
  id: "cve_00000000-0000-4000-8000-000000000001",
  providerCode: "zalo.mini_app",
  providerIdentityFingerprint: null,
  reviewedAt: null,
  reviewedByUserId: null,
  safeMetadataJson: '{"probe":"local"}',
  shopId: "shop-001",
  status: "observed" as const,
  verificationKind: "webhook" as const,
  verifiedAt: VERIFIED,
  version: 1,
};

type BundleEvidenceRow = Omit<typeof evidenceRow, "providerCode" | "providerIdentityFingerprint" | "verificationKind" | "evidenceReference"> & {
  evidenceReference: string;
  providerCode: string;
  providerIdentityFingerprint: string | null;
  verificationKind: "webhook" | "identity" | "capability";
};

type PromotionEvidenceRow = Omit<typeof evidenceRow, "providerCode" | "status" | "reviewedAt" | "reviewedByUserId" | "verificationKind" | "providerIdentityFingerprint"> & {
  providerCode: string;
  providerIdentityFingerprint: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  status: "observed" | "reviewed";
  verificationKind: "webhook" | "identity" | "capability";
};

function database(options: {
  connectionUnavailable?: boolean;
  context?: typeof contextRow;
  evidence?: typeof evidenceRow;
  evidenceRows?: readonly PromotionEvidenceRow[];
  insertChanges?: number;
} = {}) {
  let reviewed = false;
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: () => {
        void values;
        if (sql.includes("FROM shop_members")) return { allowed: 1 };
        if (sql.includes("FROM channel_connections")) {
          return options.connectionUnavailable ? null : options.context ?? contextRow;
        }
        const evidence = options.evidence ?? evidenceRow;
        return (reviewed
          ? { ...evidence, reviewedAt: VERIFIED, reviewedByUserId: "user-owner-001", status: "reviewed" as const, version: evidence.version + 1 }
          : evidence);
      },
      all: () => ({ results: options.evidenceRows ?? [] }),
      run: () => {
        if (sql.includes("UPDATE channel_provider_verification_evidence")) reviewed = true;
        return { meta: { changes: options.insertChanges ?? 1 } };
      },
    }),
  }));
  return { prepare };
}

function bundleDatabase(options: {
  changes?: readonly number[];
  context?: typeof contextRow;
  rows?: readonly BundleEvidenceRow[];
  batchError?: Error;
}) {
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: () => {
        void values;
        if (sql.includes("FROM channel_connections")) return options.context ?? { ...contextRow, providerCode: "whatsapp.cloud" };
        return null;
      },
      all: () => {
        void values;
        return { results: options.rows ?? [] };
      },
      run: () => ({ meta: { changes: 1 } }),
    }),
  }));
  const batch = vi.fn(() => {
    if (options.batchError !== undefined) throw options.batchError;
    return (options.changes ?? [1, 1, 1]).map((changes) => ({ meta: { changes } }));
  });
  return { prepare, batch };
}

function bundleRows(): readonly BundleEvidenceRow[] {
  return [
    { ...evidenceRow, providerCode: "whatsapp.cloud", verificationKind: "webhook", evidenceReference: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", providerIdentityFingerprint: null, safeMetadataJson: '{"aa":"proof","zz":true}' },
    { ...evidenceRow, providerCode: "whatsapp.cloud", verificationKind: "identity", evidenceReference: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", providerIdentityFingerprint: HASH, safeMetadataJson: '{"provider":"meta"}' },
    { ...evidenceRow, providerCode: "whatsapp.cloud", verificationKind: "capability", evidenceReference: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", providerIdentityFingerprint: null, safeMetadataJson: '{"capability":"conversation.outbound"}' },
  ];
}

describe("provider verification evidence seam", () => {
  it("records safe metadata without payloads or credentials and is replay-safe", async () => {
    const db = database({ insertChanges: 1 });
    const input = {
      connectionId: "connection-001",
      credentialFingerprint: HASH,
      credentialVersion: 1,
      evidenceReference: HASH,
      expiresAt: FUTURE,
      providerCode: "zalo.mini_app",
      requestId: "request-provider-evidence",
      safeMetadata: { probe: "local" },
      shopId: "shop-001",
      verificationKind: "webhook",
      verifiedAt: VERIFIED,
    } as const;
    await expect(recordProviderVerificationEvidence({ env: { PLATFORM_DB: db } as never, ...input })).resolves.toMatchObject({ result: "accepted" });
    expect(JSON.stringify(input)).not.toMatch(/payload|secret|token/i);
    const replay = await recordProviderVerificationEvidence({ env: { PLATFORM_DB: database({ insertChanges: 0 }) } as never, ...input });
    expect(replay.result).toBe("replay");
  });

  it("requires an owner or manager review and blocks secret-shaped metadata", async () => {
    await expect(recordProviderVerificationEvidence({
      env: { PLATFORM_DB: database() } as never,
      connectionId: "connection-001",
      credentialFingerprint: HASH,
      credentialVersion: 1,
      evidenceReference: HASH,
      expiresAt: FUTURE,
      providerCode: "zalo.mini_app",
      requestId: "request-provider-evidence",
      safeMetadata: { token: "must-not-enter" },
      shopId: "shop-001",
      verificationKind: "webhook",
      verifiedAt: VERIFIED,
    })).rejects.toMatchObject({ code: "validation_failed" });

    const db = database({ evidence: evidenceRow });
    const reviewed = await reviewProviderVerificationEvidence({
      decision: "reviewed",
      env: { PLATFORM_DB: db } as never,
      evidenceId: evidenceRow.id,
      expectedVersion: 1,
      requestId: "request-provider-evidence",
      reviewerUserId: "user-owner-001",
      shopId: "shop-001",
    });
    expect(reviewed).toMatchObject({ id: evidenceRow.id, status: "reviewed", reviewedByUserId: "user-owner-001" });
  });

  it("rejects evidence that claims a future verification time", async () => {
    await expect(recordProviderVerificationEvidence({
      env: { PLATFORM_DB: database() } as never,
      connectionId: "connection-001",
      credentialFingerprint: HASH,
      credentialVersion: 1,
      evidenceReference: HASH,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
      providerCode: "zalo.mini_app",
      requestId: "request-provider-future",
      shopId: "shop-001",
      verificationKind: "webhook",
      verifiedAt: new Date(Date.now() + 60 * 1_000).toISOString(),
    })).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it.each(["telegram.mini_app", "zalo.mini_app", "zalo.oa", "whatsapp.cloud", "discord.bot"])("never promotes coming-next provider %s, even with caller-supplied evidence", async (providerCode) => {
    const db = database();
    await expect(promoteProviderConnectionFromEvidence({
      connectionId: "connection-001",
      env: { PLATFORM_DB: db } as never,
      evidenceIds: [evidenceRow.id, "cve_00000000-0000-4000-8000-000000000002", "cve_00000000-0000-4000-8000-000000000003"],
      expectedConnectionVersion: 1,
      providerCode,
      requestId: "request-provider-promote",
      reviewerUserId: "user-owner-001",
      shopId: "shop-001",
    })).rejects.toMatchObject({ code: "channel_provider_pending", status: 409 });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("atomically records a tenant-bound evidence bundle without activating the connection", async () => {
    const db = bundleDatabase({ rows: bundleRows() });
    const result = await admitProviderVerificationEvidence({
      connectionId: "connection-001",
      credentialFingerprint: HASH,
      credentialVersion: 1,
      env: { PLATFORM_DB: db } as never,
      evidence: [
        {
          evidenceReference: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          expiresAt: FUTURE,
          safeMetadata: { zz: true, aa: "proof" },
          verificationKind: "webhook",
          verifiedAt: VERIFIED,
        },
        {
          evidenceReference: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          expiresAt: FUTURE,
          providerIdentityFingerprint: HASH,
          safeMetadata: { provider: "meta" },
          verificationKind: "identity",
          verifiedAt: VERIFIED,
        },
        {
          evidenceReference: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
          expiresAt: FUTURE,
          safeMetadata: { capability: "conversation.outbound" },
          verificationKind: "capability",
          verifiedAt: VERIFIED,
        },
      ],
      providerCode: "whatsapp.cloud",
      requestId: "request-provider-bundle",
      shopId: "shop-001",
    });
    expect(result).toMatchObject({
      mode: "recorded",
      pendingReason: "manual_review_required",
      persisted: true,
      replayedEvidenceCount: 0,
      result: "accepted",
    });
    expect(result.evidence).toHaveLength(3);
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/payload|secret|token/i);
  });

  it("returns pending-only for provider-pending contracts and never mutates D1", async () => {
    const db = bundleDatabase({ context: contextRow, rows: [] });
    const result = await admitProviderVerificationEvidence({
      connectionId: "connection-001",
      credentialFingerprint: HASH,
      credentialVersion: 1,
      env: { PLATFORM_DB: db } as never,
      evidence: [{
        evidenceReference: HASH,
        expiresAt: FUTURE,
        providerIdentityFingerprint: HASH,
        verificationKind: "identity",
        verifiedAt: VERIFIED,
      }],
      providerCode: "zalo.mini_app",
      requestId: "request-provider-pending",
      shopId: "shop-001",
    });
    expect(result).toEqual({
      evidence: [],
      mode: "pending-only",
      pendingReason: "provider_contract_pending",
      providerCode: "zalo.mini_app",
      persisted: false,
    });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("fails closed when the atomic bundle write fails", async () => {
    const db = bundleDatabase({ batchError: new Error("provider database unavailable") });
    await expect(admitProviderVerificationEvidence({
      connectionId: "connection-001",
      credentialFingerprint: HASH,
      credentialVersion: 1,
      env: { PLATFORM_DB: db } as never,
      evidence: [{ evidenceReference: HASH, expiresAt: FUTURE, verificationKind: "webhook", verifiedAt: VERIFIED }],
      providerCode: "whatsapp.cloud",
      requestId: "request-provider-failure",
      shopId: "shop-001",
    })).rejects.toMatchObject({ code: "channel_provider_verification_failed", status: 500 });
  });
});
