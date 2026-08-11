import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as releaseModule from "../../scripts/lib/release.mjs";

const release = releaseModule as unknown as {
  REQUIRED_LEGAL_SUPPORT_DECISION_KEYS: readonly string[];
  REQUIRED_WORKER_SECRET_NAMES: readonly string[];
  evaluateCommerceAcceptance: (
    evidence: Record<string, unknown>,
    artifactValidation: Record<string, Record<string, unknown>> | undefined,
    requireArtifactHash?: boolean,
  ) => Array<{ name: string; ok: boolean }>;
  validateLegalSupportDecisionEvidence: (input: Record<string, unknown>) => {
    missing: string[];
    ok: boolean;
  };
  validateSecretInventoryEvidence: (input: Record<string, unknown>) => {
    missing: string[];
    ok: boolean;
  };
  validateCandidateBoundReleaseEvidence: (input: Record<string, unknown>) => {
    missing: string[];
    ok: boolean;
  };
};

const RELEASE_ID = "release_20260809_abcdef12";
const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const OBSERVED_AT = "2026-08-08T12:00:00.000Z";
const NOW = new Date("2026-08-09T12:00:00.000Z");

function legalArtifact() {
  return {
    commitSha: COMMIT_SHA,
    decisions: Object.fromEntries(release.REQUIRED_LEGAL_SUPPORT_DECISION_KEYS.map((key) => [key, {
      effectiveAt: "2026-08-01T00:00:00.000Z",
      evidenceRef: `private/legal-support/${key}.json`,
      ownerRef: `private/approvals/${key}.json`,
      status: "approved",
    }])),
    environment: "production",
    mode: "legal_support_decision_checklist",
    observedAt: OBSERVED_AT,
    releaseId: RELEASE_ID,
    schemaVersion: 1,
    treeSha: TREE_SHA,
  };
}

async function writeArtifact(root: string, relativeRef: string, value: Record<string, unknown>, mode = 0o600) {
  const path = join(root, relativeRef);
  await mkdir(join(path, ".."), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(path, bytes, { mode });
  await chmod(path, mode);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("release evidence hardening", () => {
  it("requires a mode-0600, hash-bound, schema-bound legal/support checklist", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-release-legal-"));
    const ref = `.wrangler/releases/${RELEASE_ID}/legal-support-decisions.json`;
    try {
      const artifact = legalArtifact();
      const artifactSha256 = await writeArtifact(root, ref, artifact);
      const evidence = {
        commitSha: COMMIT_SHA,
        legalSupport: {
          accepted: true,
          artifactSchemaVersion: 1,
          artifactSha256,
          evidenceRef: ref,
          observedAt: OBSERVED_AT,
          requiredDecisionKeys: [...release.REQUIRED_LEGAL_SUPPORT_DECISION_KEYS],
        },
        releaseId: RELEASE_ID,
        treeSha: TREE_SHA,
      };

      expect(release.validateLegalSupportDecisionEvidence({ evidence, now: NOW, repositoryRoot: root }).ok).toBe(true);

      const platformSupportContact = (artifact.decisions as Record<string, { status: string }>).platformSupportContact;
      if (platformSupportContact === undefined) throw new Error("legal_support_fixture_missing_platform_contact");
      platformSupportContact.status = "pending";
      await writeArtifact(root, ref, artifact);
      const rejected = release.validateLegalSupportDecisionEvidence({ evidence, now: NOW, repositoryRoot: root });
      expect(rejected.ok).toBe(false);
      expect(rejected.missing).toContain("evidence.legalSupport.artifactHash");
      expect(rejected.missing).toContain("evidence.legalSupport.decisions");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the secret inventory name-only and permits additional rotated names", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-release-secrets-"));
    const ref = `.wrangler/releases/${RELEASE_ID}/production-secret-inventory.json`;
    try {
      const secretNames = [...release.REQUIRED_WORKER_SECRET_NAMES, "CREDENTIAL_KEK_V2"];
      const artifact = {
        commitSha: COMMIT_SHA,
        environment: "production",
        mode: "name_only",
        releaseId: RELEASE_ID,
        schemaVersion: 1,
        secretNames,
        treeSha: TREE_SHA,
      };
      const artifactSha256 = await writeArtifact(root, ref, artifact);
      const evidence = {
        commitSha: COMMIT_SHA,
        releaseId: RELEASE_ID,
        secretInventory: {
          artifactSha256,
          evidenceRef: ref,
          mode: "name_only",
          requiredNames: secretNames,
          schemaVersion: 1,
        },
        treeSha: TREE_SHA,
      };

      expect(release.validateSecretInventoryEvidence({
        evidence,
        repositoryRoot: root,
        workerSecretNames: secretNames,
      }).ok).toBe(true);

      const namesDrift = release.validateSecretInventoryEvidence({
        evidence: {
          ...evidence,
          secretInventory: {
            ...evidence.secretInventory,
            requiredNames: [...secretNames, "CREDENTIAL_KEK_V3"],
          },
        },
        repositoryRoot: root,
        workerSecretNames: secretNames,
      });
      expect(namesDrift.ok).toBe(false);
      expect(namesDrift.missing).toContain("evidence.secretInventory.namesMatchEvidence");

      const secretLeak = release.validateSecretInventoryEvidence({
        evidence: {
          ...evidence,
          secretInventory: {
            ...evidence.secretInventory,
            rawSecretValues: { SESSION_SECRET: "must-not-be-accepted" },
          },
        },
        repositoryRoot: root,
        workerSecretNames: secretNames,
      });
      expect(secretLeak.ok).toBe(false);
      expect(secretLeak.missing).toContain("evidence.secretInventory.schema");

      const firstSecretName = artifact.secretNames[0];
      if (firstSecretName === undefined) throw new Error("secret_inventory_fixture_empty");
      artifact.secretNames[0] = `${firstSecretName}=plaintext`;
      await writeArtifact(root, ref, artifact);
      expect(release.validateSecretInventoryEvidence({
        evidence,
        repositoryRoot: root,
        workerSecretNames: secretNames,
      }).missing).toContain("evidence.secretInventory.artifactNames");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("binds each declared Dodo and PayOS hash to the bytes accepted by artifact validation", () => {
    const payosSha256 = "c".repeat(64);
    const declaredDodoSha256 = "d".repeat(64);
    const evidence = {
      commerceAcceptance: {
        dodo: {
          accepted: true,
          artifactSha256: declaredDodoSha256,
          evidenceRef: ".wrangler/releases/staging/stg_20260809T010203Z_0123456789ab/dodo-uat-evidence.json",
          observedAt: OBSERVED_AT,
        },
        payos: {
          accepted: true,
          artifactSha256: payosSha256,
          evidenceRef: ".wrangler/releases/staging/stg_20260809T010203Z_0123456789ab/payos-uat-evidence.json",
          observedAt: OBSERVED_AT,
        },
      },
      staging: {
        manifestRef: ".wrangler/releases/staging/stg_20260809T010203Z_0123456789ab/release-manifest.json",
        manifestSha256: "e".repeat(64),
        releaseId: "stg_20260809T010203Z_0123456789ab",
        workerVersion: "worker-version-abcdef",
      },
    };
    const binding = {
      accepted: true,
      manifestRef: evidence.staging.manifestRef,
      manifestSha256: evidence.staging.manifestSha256,
      releaseId: evidence.staging.releaseId,
      workerVersion: evidence.staging.workerVersion,
    };
    const checks = release.evaluateCommerceAcceptance(evidence, {
      dodo: { ...binding, artifactFingerprintSha256: "f".repeat(64) },
      payos: { ...binding, artifactFingerprintSha256: payosSha256 },
    }, true);

    expect(checks.find((check) => check.name === "evidence.commerceAcceptance.payos.artifactSha256Binding")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "evidence.commerceAcceptance.dodo.artifactSha256Binding")?.ok).toBe(false);
  });

  it("requires quality, manual, pilot and monitoring evidence to bind to one candidate artifact each", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-release-candidate-evidence-"));
    const candidateWorkerVersion = "33333333-3333-4333-8333-333333333333";
    const sections = {
      manualAcceptance: {
        customDomain: true,
        paymentSignedEvent: true,
        telegram: true,
        website: true,
        observedAt: OBSERVED_AT,
      },
      monitoring: {
        alertsReady: true,
        budgetAlertsReady: true,
        dashboardReady: true,
        observedAt: OBSERVED_AT,
      },
      pilot: {
        completedAt: OBSERVED_AT,
        shopCount: 2,
      },
      quality: {
        auditHigh: true,
        build: true,
        buildStaging: true,
        check: true,
        deployDryRun: true,
        deployStagingDryRun: true,
        gitDiffCheck: true,
        lint: true,
        schemaVersion: 2,
        test: true,
        tscNoEmit: true,
        observedAt: OBSERVED_AT,
      },
    } as const;
    const evidence: Record<string, unknown> = {
      candidateWorkerVersion,
      commitSha: COMMIT_SHA,
      releaseId: RELEASE_ID,
      treeSha: TREE_SHA,
    };
    try {
      for (const [section, values] of Object.entries(sections)) {
        const fileName = section === "manualAcceptance"
          ? "manual-acceptance.json"
          : `${section}-evidence.json`;
        const ref = `.wrangler/releases/${RELEASE_ID}/${fileName}`;
        const definitionMode = section === "manualAcceptance"
          ? "manual_acceptance"
          : section === "monitoring"
            ? "monitoring_evidence"
            : section === "pilot"
              ? "pilot_evidence"
              : "quality_evidence";
        const timestampField = section === "pilot" ? "completedAt" : "observedAt";
        const evidenceKeys = section === "manualAcceptance"
          ? ["customDomain", "paymentSignedEvent", "telegram", "website"]
          : section === "monitoring"
            ? ["alertsReady", "budgetAlertsReady", "dashboardReady"]
            : section === "pilot"
              ? ["shopCount"]
              : ["auditHigh", "build", "buildStaging", "check", "deployDryRun", "deployStagingDryRun", "gitDiffCheck", "lint", "schemaVersion", "test", "tscNoEmit"];
        const artifact = {
          commitSha: COMMIT_SHA,
          environment: "production",
          evidence: Object.fromEntries(evidenceKeys.map((key) => [key, values[key as keyof typeof values]])),
          mode: definitionMode,
          observedAt: values[timestampField as keyof typeof values],
          releaseId: RELEASE_ID,
          schemaVersion: 1,
          treeSha: TREE_SHA,
          workerVersion: candidateWorkerVersion,
        };
        const artifactSha256 = await writeArtifact(root, ref, artifact);
        evidence[section] = {
          ...values,
          artifactSchemaVersion: 1,
          artifactSha256,
          evidenceRef: ref,
        };
      }

      const valid = release.validateCandidateBoundReleaseEvidence({ evidence, now: NOW, repositoryRoot: root });
      expect(valid.ok, JSON.stringify(valid.missing)).toBe(true);

      const tamperedArtifact = {
        commitSha: COMMIT_SHA,
        environment: "production",
        evidence: { alertsReady: true, budgetAlertsReady: true, dashboardReady: true },
        mode: "monitoring_evidence",
        observedAt: OBSERVED_AT,
        releaseId: RELEASE_ID,
        schemaVersion: 1,
        treeSha: TREE_SHA,
        workerVersion: "44444444-4444-4444-8444-444444444444",
      };
      const monitoringEvidence = evidence.monitoring as Record<string, unknown>;
      monitoringEvidence.artifactSha256 = await writeArtifact(root, String(monitoringEvidence.evidenceRef), tamperedArtifact);
      const rejected = release.validateCandidateBoundReleaseEvidence({ evidence, now: NOW, repositoryRoot: root });
      expect(rejected.ok).toBe(false);
      expect(rejected.missing).toContain("evidence.monitoring.artifactBinding");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
