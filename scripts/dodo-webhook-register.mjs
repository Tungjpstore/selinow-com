import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

import { ensureDodoWebhook, fingerprintDodoWebhookReference } from "./lib/dodo-webhook-registration.mjs";

function parse(argv) {
  const options = { environment: null, execute: false, acknowledgeLive: false };
  for (const argument of argv) {
    if (argument === "--execute") options.execute = true;
    else if (argument === "--ack-live") options.acknowledgeLive = true;
    else if (argument === "--env=staging") options.environment = "staging";
    else if (argument === "--env=production") options.environment = "production";
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.environment === null) throw new Error("dodo_webhook_environment_required");
  if (options.environment === "production" && options.execute && !options.acknowledgeLive) throw new Error("dodo_webhook_live_ack_required");
  return options;
}

function safeError(error) {
  return error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "dodo_webhook_registration_failed";
}

function putWorkerSecret(environment, secret) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", "DODO_PAYMENTS_WEBHOOK_KEY", "--env", environment], {
    encoding: "utf8",
    input: `${secret}\n`,
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("dodo_webhook_worker_secret_failed");
}

try {
  const options = parse(process.argv.slice(2));
  const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const vars = wrangler.env?.[options.environment]?.vars;
  const apiOrigin = vars?.API_ORIGIN;
  const publicId = vars?.DODO_PAYMENTS_WEBHOOK_PUBLIC_ID;
  const providerEnvironment = vars?.DODO_PAYMENTS_ENVIRONMENT;
  if (typeof apiOrigin !== "string" || typeof publicId !== "string" || !/^(?:ddowh|dodow)_[0-9a-f-]{36}$/u.test(publicId)) throw new Error("dodo_webhook_runtime_contract_invalid");
  if ((options.environment === "staging" && providerEnvironment !== "test_mode") || (options.environment === "production" && providerEnvironment !== "live_mode")) throw new Error("dodo_webhook_provider_environment_invalid");
  const endpointUrl = `${apiOrigin.replace(/\/+$/u, "")}/api/webhooks/billing/dodo/${publicId}`;
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ action: "would_register_and_store_signing_key", endpointFingerprintSha256: fingerprintDodoWebhookReference("endpoint", endpointUrl), environment: options.environment, providerEnvironment }, null, 2)}\n`);
  } else {
    const apiKey = process.env.DODO_PAYMENTS_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length < 16) throw new Error("dodo_webhook_api_key_required");
    const probe = await globalThis.fetch(endpointUrl, { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST", redirect: "manual" });
    if (probe.status === 404 || probe.status >= 500 && probe.status !== 503) throw new Error("dodo_webhook_route_not_admitted");
    const apiBaseUrl = providerEnvironment === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
    const result = await ensureDodoWebhook({ apiBaseUrl, apiKey, endpointUrl, fetcher: globalThis.fetch });
    putWorkerSecret(options.environment, result.secret);
    process.stdout.write(`${JSON.stringify({ created: result.created, endpointFingerprintSha256: result.endpointFingerprintSha256, environment: options.environment, providerWebhookFingerprintSha256: result.providerWebhookFingerprintSha256, workerSecretName: "DODO_PAYMENTS_WEBHOOK_KEY" }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
}
