import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  assertIsolatedWranglerSecrets,
  assertOwnedDevServerStart,
  buildLocalCommandEnvironment,
  localBrowserBaseUrl,
  resolveLocalBrowserPort,
  validatePlaywrightArguments,
  writeIsolatedDevVars,
  writeIsolatedWranglerConfig,
} from "./lib/local-auth-browser-gate.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const forwardedArgs = validatePlaywrightArguments(process.argv.slice(2));
const port = resolveLocalBrowserPort(process.env.SELINOW_AUTH_BROWSER_PORT);
const baseUrl = localBrowserBaseUrl(port);

function localSecret() {
  return randomBytes(32).toString("base64url");
}

const stateDirectory = mkdtempSync(join(tmpdir(), "selinow-auth-browser-"));
let environment;
let devServerOwned = false;
let cleanupComplete = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command}_failed_${String(result.status ?? "unknown")}`);
  }
  return options.capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
}

function assertNoDevServer() {
  const status = run("npx", ["--no-install", "astro", "dev", "status"], { capture: true });
  if (!status.includes("No dev server is running")) {
    throw new Error("local_auth_browser_gate_dev_server_already_running");
  }
}

function stopDevServer() {
  if (!devServerOwned || environment === undefined) return;
  const result = spawnSync("npx", ["--no-install", "astro", "dev", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write("local_auth_browser_gate_dev_server_stop_failed\n");
  }
  devServerOwned = false;
}

function cleanup() {
  if (cleanupComplete) return;
  cleanupComplete = true;
  stopDevServer();
  rmSync(stateDirectory, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

let exitCode;
try {
  const wranglerConfigPath = writeIsolatedWranglerConfig(repositoryRoot, stateDirectory, baseUrl);
  const { secrets } = writeIsolatedDevVars(stateDirectory, localSecret);
  assertIsolatedWranglerSecrets(wranglerConfigPath, secrets);
  environment = buildLocalCommandEnvironment({
    baseUrl,
    sourceEnvironment: process.env,
    stateDirectory,
    wranglerConfigPath,
  });
  assertNoDevServer();
  run("npx", ["--no-install", "wrangler", "d1", "migrations", "apply", "PLATFORM_DB", "--config", wranglerConfigPath, "--local", "--persist-to", stateDirectory]);
  run("npx", ["--no-install", "wrangler", "d1", "execute", "PLATFORM_DB", "--config", wranglerConfigPath, "--local", "--persist-to", stateDirectory, "--file", "./seeds/0001_platform_defaults.sql"]);
  run("npx", ["--no-install", "wrangler", "d1", "execute", "PLATFORM_DB", "--config", wranglerConfigPath, "--local", "--persist-to", stateDirectory, "--file", "./seeds/0004_local_authenticated_browser.sql"]);
  const startOutput = run("npx", [
    "--no-install",
    "astro",
    "dev",
    "--background",
    "--host",
    "127.0.0.1",
    "--port",
    port,
    "--allowed-hosts",
    "app.localhost,localhost,127.0.0.1",
  ], { capture: true });
  assertOwnedDevServerStart(startOutput, port);
  devServerOwned = true;

  const result = spawnSync("npx", ["--no-install", "playwright", "test", "--config", "playwright.auth.config.ts", ...forwardedArgs], {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  exitCode = result.error === undefined && result.status !== null ? result.status : 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "local_auth_browser_gate_failed"}\n`);
  exitCode = 1;
} finally {
  cleanup();
}

process.exitCode = exitCode ?? 1;
