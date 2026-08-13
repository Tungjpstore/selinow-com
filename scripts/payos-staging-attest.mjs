import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import process from "node:process";
import { basename, dirname, resolve } from "node:path";

import { assertPaymentProviderMutationAdmission } from "./lib/payment-provider-mutation-admission.mjs";

const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;

function parseArguments(argumentsList) {
  const options = { evidencePath: null, execute: false, manifestPath: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--release-manifest") options.manifestPath = argumentsList[++index] ?? "";
    else if (argument.startsWith("--release-manifest=")) options.manifestPath = argument.slice("--release-manifest=".length);
    else if (argument === "--fingerprint-evidence") options.evidencePath = argumentsList[++index] ?? "";
    else if (argument.startsWith("--fingerprint-evidence=")) options.evidencePath = argument.slice("--fingerprint-evidence=".length);
    else throw new Error("payos_attestation_argument_invalid");
  }
  return options;
}

async function readFingerprintEvidence(path) {
  const resolvedPath = resolve(path);
  let entry;
  try {
    entry = await lstat(resolvedPath);
  } catch {
    throw new Error("payos_fingerprint_evidence_missing");
  }
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
    throw new Error("payos_fingerprint_evidence_permissions_invalid");
  }
  if ((await lstat(dirname(resolvedPath))).isSymbolicLink()) {
    throw new Error("payos_fingerprint_evidence_permissions_invalid");
  }
  const canonicalPath = resolve(await realpath(dirname(resolvedPath)), basename(resolvedPath));
  let handle;
  try {
    if (await realpath(resolvedPath) !== canonicalPath) throw new Error("payos_fingerprint_evidence_permissions_invalid");
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error("payos_fingerprint_evidence_permissions_invalid", { cause: error });
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const pathStat = await stat(canonicalPath, { bigint: true });
    if (!opened.isFile()
      || (opened.mode & 0o077n) !== 0n
      || opened.dev !== pathStat.dev
      || opened.ino !== pathStat.ino) {
      throw new Error("payos_fingerprint_evidence_permissions_invalid");
    }
    const bytes = await handle.readFile();
    const closedOver = await handle.stat({ bigint: true });
    const finalPathStat = await stat(canonicalPath, { bigint: true });
    if (opened.dev !== closedOver.dev
      || opened.ino !== closedOver.ino
      || opened.size !== closedOver.size
      || opened.mtimeNs !== closedOver.mtimeNs
      || opened.ctimeNs !== closedOver.ctimeNs
      || finalPathStat.dev !== opened.dev
      || finalPathStat.ino !== opened.ino) {
      throw new Error("payos_fingerprint_evidence_permissions_invalid");
    }
    const evidence = JSON.parse(bytes.toString("utf8"));
    const keys = evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
      ? Object.keys(evidence).sort()
      : [];
    if (keys.join(",") !== "environment,fingerprint,ok,requestId"
      || evidence.environment !== "staging"
      || evidence.ok !== true
      || typeof evidence.fingerprint !== "string"
      || !FINGERPRINT.test(evidence.fingerprint)
      || typeof evidence.requestId !== "string"
      || !REQUEST_ID.test(evidence.requestId)) {
      throw new Error("payos_fingerprint_evidence_invalid");
    }
    return evidence.fingerprint;
  } catch (error) {
    if (error instanceof Error && (error.message === "payos_fingerprint_evidence_permissions_invalid" || error.message === "payos_fingerprint_evidence_invalid")) {
      throw error;
    }
    throw new Error("payos_fingerprint_evidence_invalid", { cause: error });
  } finally {
    await handle.close();
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.execute && (typeof options.manifestPath !== "string" || options.manifestPath.length === 0)) throw new Error("payos_attestation_release_manifest_required");
  if (options.execute && (typeof options.evidencePath !== "string" || options.evidencePath.length === 0)) throw new Error("payos_fingerprint_evidence_required");
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ action: "would_attest_controlled_staging_channel", environment: "staging", workerSecretName: "PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT" }, null, 2)}\n`);
  } else {
    const value = await readFingerprintEvidence(options.evidencePath);
    const { childEnvironment } = await assertPaymentProviderMutationAdmission({ environment: "staging", manifestPath: options.manifestPath });
    // The configured Wrangler environment owns the exact Worker name. Passing
    // --name alongside --env causes Wrangler to append the environment twice.
    const result = spawnSync("npx", ["--no-install", "wrangler", "secret", "put", "PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT", "--env", "staging"], {
      encoding: "utf8",
      env: childEnvironment,
      input: `${value}\n`,
      stdio: ["pipe", "ignore", "pipe"],
    });
    if (result.error || result.status !== 0) throw new Error("payos_staging_attestation_failed");
    process.stdout.write(`${JSON.stringify({ attested: true, environment: "staging", workerSecretName: "PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT" }, null, 2)}\n`);
  }
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message) ? error.message : "payos_staging_attestation_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
