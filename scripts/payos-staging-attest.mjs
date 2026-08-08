import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";

const PURPOSE = "payos-provider-identity:v1";

function fingerprint(secret, clientId) {
  return createHmac("sha256", secret).update(`${PURPOSE}\0${clientId.trim()}`).digest("base64url");
}

try {
  const argumentsList = process.argv.slice(2);
  const execute = argumentsList.includes("--execute");
  if (argumentsList.some((argument) => argument !== "--execute")) throw new Error("payos_attestation_argument_invalid");
  if (!execute) {
    process.stdout.write(`${JSON.stringify({ action: "would_attest_controlled_staging_channel", environment: "staging", workerSecretName: "PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT" }, null, 2)}\n`);
  } else {
    const clientId = process.env.PAYOS_CONTROLLED_STAGING_CLIENT_ID;
    const hmacSecret = process.env.IDENTIFIER_HMAC_SECRET;
    if (typeof clientId !== "string" || clientId.trim().length < 3) throw new Error("payos_controlled_client_id_required");
    if (typeof hmacSecret !== "string" || hmacSecret.length < 16) throw new Error("payos_identifier_hmac_secret_required");
    const value = fingerprint(hmacSecret, clientId);
    const result = spawnSync("npx", ["wrangler", "secret", "put", "PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT", "--env", "staging"], {
      encoding: "utf8",
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
