import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

function temporaryEvidence(value: unknown, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "selinow-payos-attestation-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "fingerprint.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

function executeWithEvidence(path?: string) {
  const argumentsList = [
    "scripts/payos-staging-attest.mjs",
    "--execute",
    "--release-manifest",
    ".wrangler/releases/staging/not-used-in-input-validation/release-manifest.json",
  ];
  if (path !== undefined) argumentsList.push("--fingerprint-evidence", path);
  return spawnSync(process.execPath, argumentsList, {
    encoding: "utf8",
    env: {
      ...process.env,
      IDENTIFIER_HMAC_SECRET: "must-never-be-consumed",
      PAYOS_CONTROLLED_STAGING_CLIENT_ID: "must-never-be-consumed",
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("PayOS staging attestation secret boundary", () => {
  it("never derives the provider fingerprint in the operator process", () => {
    const source = readFileSync("scripts/payos-staging-attest.mjs", "utf8");
    expect(source).not.toContain("IDENTIFIER_HMAC_SECRET");
    expect(source).not.toContain("PAYOS_CONTROLLED_STAGING_CLIENT_ID");
    expect(source).not.toContain("createHmac");
    expect(source).not.toContain("payos-provider-identity:v1");
  });

  it("requires private Worker-derived fingerprint evidence for execution", () => {
    const result = executeWithEvidence();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("payos_fingerprint_evidence_required\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain("must-never-be-consumed");
  });

  it("rejects a missing fingerprint evidence file before release admission", () => {
    const result = executeWithEvidence(join(tmpdir(), "selinow-missing-payos-fingerprint.json"));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("payos_fingerprint_evidence_missing\n");
  });

  it("rejects fingerprint evidence readable by group or other users", () => {
    const path = temporaryEvidence({
      environment: "staging",
      fingerprint: "a".repeat(43),
      ok: true,
      requestId: "payos-fingerprint-test",
    }, 0o640);
    const result = executeWithEvidence(path);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("payos_fingerprint_evidence_permissions_invalid\n");
  });

  it("rejects fingerprint evidence reached through a symlinked ancestor", () => {
    const directory = mkdtempSync(join(tmpdir(), "selinow-payos-attestation-link-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target");
    const linked = join(directory, "linked");
    mkdirSync(target, { mode: 0o700 });
    const evidence = join(target, "fingerprint.json");
    writeFileSync(evidence, JSON.stringify({
      environment: "staging",
      fingerprint: "a".repeat(43),
      ok: true,
      requestId: "payos-fingerprint-test",
    }), { mode: 0o600 });
    symlinkSync(target, linked, "dir");
    const result = executeWithEvidence(join(linked, "fingerprint.json"));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("payos_fingerprint_evidence_permissions_invalid\n");
  });

  it.each([
    [{ environment: "production", fingerprint: "a".repeat(43), ok: true, requestId: "payos-fingerprint-test" }],
    [{ environment: "staging", fingerprint: "too-short", ok: true, requestId: "payos-fingerprint-test" }],
    [{ environment: "staging", fingerprint: "a".repeat(43), ok: false, requestId: "payos-fingerprint-test" }],
    [{ environment: "staging", fingerprint: "a".repeat(43), ok: true, requestId: "short" }],
    [{ environment: "staging", fingerprint: "a".repeat(43), ok: true, requestId: "payos-fingerprint-test", clientId: "forbidden" }],
  ])("rejects malformed or over-broad endpoint evidence", (evidence) => {
    const result = executeWithEvidence(temporaryEvidence(evidence));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("payos_fingerprint_evidence_invalid\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain("a".repeat(43));
  });

  it("keeps dry-run output non-sensitive and mutation admission ahead of Wrangler", () => {
    const dryRun = spawnSync(process.execPath, ["scripts/payos-staging-attest.mjs"], { encoding: "utf8" });
    const output = JSON.parse(dryRun.stdout) as Record<string, unknown>;
    expect(dryRun.status).toBe(0);
    expect(output).toEqual({
      action: "would_attest_controlled_staging_channel",
      environment: "staging",
      workerSecretName: "PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT",
    });

    const source = readFileSync("scripts/payos-staging-attest.mjs", "utf8");
    expect(source.indexOf("assertPaymentProviderMutationAdmission({")).toBeGreaterThan(-1);
    expect(source.indexOf("assertPaymentProviderMutationAdmission({")).toBeLessThan(source.indexOf('spawnSync("npx"'));
    expect(source).toContain('"--env", "staging"]');
    expect(source).not.toContain('"--name"');
  });
});
