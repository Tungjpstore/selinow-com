import { createHash, generateKeyPairSync } from "node:crypto";
import * as actualFs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("private artifact descriptor binding", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it("rejects a trust-anchor pathname replaced after validation but before the descriptor check", async () => {
    const root = mkdtempSync(join(tmpdir(), "selinow-artifact-race-"));
    roots.push(root);
    const target = join(root, "runner-public.pem");
    const replacement = join(root, "runner-public-replacement.pem");
    const displaced = join(root, "runner-public-displaced.pem");
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
    writeFileSync(target, publicKeyPem, { mode: 0o600 });
    writeFileSync(replacement, publicKeyPem, { mode: 0o600 });

    let swapped = false;
    const swapTarget = () => {
      if (swapped) return;
      swapped = true;
      actualFs.renameSync(target, displaced);
      actualFs.renameSync(replacement, target);
    };
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: actualFs.PathLike, options?: actualFs.StatOptions) {
        const result = actualFs.lstatSync(path, options as never);
        if (String(path) === target) swapTarget();
        return result;
      },
      openSync(path: actualFs.PathLike, flags: actualFs.OpenMode, mode?: actualFs.Mode) {
        const descriptor = actualFs.openSync(path, flags, mode);
        if (String(path) === target) swapTarget();
        return descriptor;
      },
    }));

    const { readPayosRunnerTrustAnchor } = await import("../../scripts/lib/payos-uat-evidence.mjs");
    const spkiSha256 = createHash("sha256")
      .update(publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");

    expect(() => readPayosRunnerTrustAnchor({
      keyId: "payos-staging-runner",
      publicKeyPath: "runner-public.pem",
      repositoryRoot: root,
      spkiSha256,
    })).toThrow("payos_uat_runner_public_key_invalid");
    expect(swapped).toBe(true);
  });
});
