import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

function writeKeyring(root: string) {
  const keys = generateKeyPairSync("ed25519");
  const path = `${root}/trusted-keys.json`;
  const keyId = "dodo-staging-runner-v1";
  const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" });
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    environment: "staging",
    provider: "dodo",
    keys: [{
      keyId,
      publicKeyPem,
    }],
  })}\n`, { mode: 0o600 });
  return {
    keyId,
    path,
    spkiSha256: createHash("sha256").update(keys.publicKey.export({ format: "der", type: "spki" })).digest("hex"),
  };
}

function trustArguments(keyring: ReturnType<typeof writeKeyring>) {
  return [
    "--trusted-public-keys", keyring.path,
    "--approved-key-id", keyring.keyId,
    "--approved-spki-sha256", keyring.spkiSha256,
  ];
}

describe("Dodo staging UAT command tooling", () => {
  it("requires the collector input to be an exact mode-0600 file", () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-cli-`);
    try {
      const input = `${root}/input.json`;
      writeFileSync(input, "{}\n", { mode: 0o600 });
      chmodSync(input, 0o644);
      const result = run("scripts/dodo-uat-collect.mjs", ["--input", input, ...trustArguments(writeKeyring(root))]);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("dodo_uat_input_permissions_invalid");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe collector fields without echoing their values", () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-cli-unsafe-`);
    try {
      const input = `${root}/input.json`;
      const sensitive = "do-not-echo-private-payload";
      writeFileSync(input, `${JSON.stringify({ rawPayload: sensitive })}\n`, { mode: 0o600 });
      const result = run("scripts/dodo-uat-collect.mjs", ["--input", input, ...trustArguments(writeKeyring(root))]);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("dodo_uat_field_unsafe");
      expect(`${result.stdout}${result.stderr}`).not.toContain(sensitive);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an independently supplied mode-0600 trusted runner keyring", () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-cli-keyring-`);
    try {
      const input = `${root}/input.json`;
      writeFileSync(input, "{}\n", { mode: 0o600 });
      const missing = run("scripts/dodo-uat-collect.mjs", ["--input", input]);
      expect(missing.status).toBe(1);
      expect(missing.stderr.trim()).toBe("dodo_uat_trusted_public_keys_required");

      const keyring = writeKeyring(root);
      const keyringOnly = run("scripts/dodo-uat-collect.mjs", ["--input", input, "--trusted-public-keys", keyring.path]);
      expect(keyringOnly.status).toBe(1);
      expect(keyringOnly.stderr.trim()).toBe("dodo_uat_approved_execution_proof_trust_required");

      chmodSync(keyring.path, 0o644);
      const exposed = run("scripts/dodo-uat-collect.mjs", ["--input", input, ...trustArguments(keyring)]);
      expect(exposed.status).toBe(1);
      expect(exposed.stderr.trim()).toBe("dodo_uat_trusted_public_keys_permissions_invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the standalone evidence file itself to be mode 0600", () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-validator-`);
    try {
      const evidence = `${root}/evidence.json`;
      writeFileSync(evidence, "{}\n", { mode: 0o600 });
      chmodSync(evidence, 0o640);
      const result = run("scripts/dodo-uat-validate.mjs", [
        "--evidence", evidence,
        "--manifest", `${root}/release-manifest.json`,
        "--worker-version", "worker-version-0001",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("dodo_uat_evidence_permissions_invalid");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires and parses independently approved runner trust for validation", () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-validator-trust-`);
    try {
      const evidence = `${root}/evidence.json`;
      const manifest = `${root}/release-manifest.json`;
      writeFileSync(evidence, "{}\n", { mode: 0o600 });
      const keyring = writeKeyring(root);

      const missingTrust = run("scripts/dodo-uat-validate.mjs", [
        "--evidence", evidence,
        "--manifest", manifest,
        "--worker-version", "worker-version-0001",
        "--trusted-public-keys", keyring.path,
      ]);
      expect(missingTrust.status).toBe(1);
      expect(missingTrust.stderr.trim()).toBe("dodo_uat_approved_execution_proof_trust_required");

      const acceptedArguments = run("scripts/dodo-uat-validate.mjs", [
        "--evidence", evidence,
        "--manifest", manifest,
        "--worker-version", "worker-version-0001",
        ...trustArguments(keyring),
      ]);
      expect(acceptedArguments.status).toBe(1);
      expect(acceptedArguments.stderr.trim()).toBe("dodo_uat_evidence_path_invalid");
      expect(acceptedArguments.stderr).not.toContain("unknown_argument");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
