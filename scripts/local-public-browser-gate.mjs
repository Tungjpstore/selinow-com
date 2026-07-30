import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  assertIsolatedWranglerSecrets,
  assertOwnedDevServerStart,
  buildLocalPublicCommandEnvironment,
  validatePublicPlaywrightArguments,
  writeIsolatedDevVars,
  writeIsolatedWranglerConfig,
} from "./lib/local-public-browser-gate.mjs";
import { resolveLocalBrowserPort } from "./lib/local-auth-browser-gate.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const forwardedArgs = validatePublicPlaywrightArguments(process.argv.slice(2));
async function isPortAvailable(portNumber) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(portNumber, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolvePublicBrowserPort() {
  const configured = process.env.SELINOW_PUBLIC_BROWSER_PORT;
  if (configured !== undefined) {
    const portNumber = Number(resolveLocalBrowserPort(configured));
    if (!(await isPortAvailable(portNumber))) throw new Error("local_public_browser_gate_port_busy");
    return String(portNumber);
  }
  for (let portNumber = 4_399; portNumber <= 4_409; portNumber += 1) {
    if (await isPortAvailable(portNumber)) return String(portNumber);
  }
  throw new Error("local_public_browser_gate_no_free_port");
}

const port = await resolvePublicBrowserPort();
const marketingOrigin = `http://localhost:${port}`;
const stateDirectory = mkdtempSync(`${tmpdir()}/selinow-public-browser-`);
let environment;
let devServerOwned = false;
let cleanupComplete = false;

function localSecret() {
  return randomBytes(32).toString("base64url");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command}_failed_${String(result.status ?? "unknown")}`);
  return options.capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
}

function assertNoDevServer() {
  const status = run("npx", ["--no-install", "astro", "dev", "status"], { capture: true });
  if (!status.includes("No dev server is running")) throw new Error("local_public_browser_gate_dev_server_already_running");
}

function stopDevServer() {
  if (!devServerOwned || environment === undefined) return;
  const result = spawnSync("npx", ["--no-install", "astro", "dev", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error !== undefined || result.status !== 0) process.stderr.write("local_public_browser_gate_dev_server_stop_failed\n");
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

let exitCode = 1;
try {
  const wranglerConfigPath = writeIsolatedWranglerConfig(repositoryRoot, stateDirectory, `http://app.localhost:${port}`);
  const { secrets } = writeIsolatedDevVars(stateDirectory, localSecret);
  assertIsolatedWranglerSecrets(wranglerConfigPath, secrets);
  environment = buildLocalPublicCommandEnvironment({
    baseUrl: marketingOrigin,
    sourceEnvironment: process.env,
    stateDirectory,
    wranglerConfigPath,
  });
  assertNoDevServer();
  run("npx", ["--no-install", "wrangler", "d1", "migrations", "apply", "PLATFORM_DB", "--config", wranglerConfigPath, "--local", "--persist-to", stateDirectory], { capture: true });
  run("npx", ["--no-install", "wrangler", "d1", "execute", "PLATFORM_DB", "--config", wranglerConfigPath, "--local", "--persist-to", stateDirectory, "--file", "./seeds/0001_platform_defaults.sql"], { capture: true });
  run("npx", ["--no-install", "wrangler", "d1", "execute", "PLATFORM_DB", "--config", wranglerConfigPath, "--local", "--persist-to", stateDirectory, "--file", "./seeds/0003_phase6_demo.sql"], { capture: true });
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
    "localhost,app.localhost,signal.localhost,api.localhost,127.0.0.1",
  ], { capture: true });
  assertOwnedDevServerStart(startOutput, port);
  devServerOwned = true;

  const result = spawnSync("npx", ["--no-install", "playwright", "test", "--config", "playwright.public-local.config.ts", ...forwardedArgs], {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  exitCode = result.error === undefined && result.status !== null ? result.status : 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "local_public_browser_gate_failed"}\n`);
} finally {
  cleanup();
}

process.exitCode = exitCode;
