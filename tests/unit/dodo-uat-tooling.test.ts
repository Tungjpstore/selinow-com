import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

describe("Dodo staging UAT command tooling", () => {
  it("requires the collector input to be an exact mode-0600 file", () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-cli-`);
    try {
      const input = `${root}/input.json`;
      writeFileSync(input, "{}\n", { mode: 0o600 });
      chmodSync(input, 0o644);
      const result = run("scripts/dodo-uat-collect.mjs", ["--input", input]);
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
      const result = run("scripts/dodo-uat-collect.mjs", ["--input", input]);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("dodo_uat_field_unsafe");
      expect(`${result.stdout}${result.stderr}`).not.toContain(sensitive);
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
});
