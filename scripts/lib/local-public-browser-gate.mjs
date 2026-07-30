import { join } from "node:path";
import { URL } from "node:url";

import {
  assertIsolatedWranglerSecrets,
  assertOwnedDevServerStart,
  buildLocalCommandEnvironment,
  resolveLocalBrowserPort,
  writeIsolatedDevVars,
  writeIsolatedWranglerConfig,
} from "./local-auth-browser-gate.mjs";

export const publicBrowserOrigins = Object.freeze({
  api: "api.localhost",
  dashboard: "app.localhost",
  marketing: "localhost",
  storefront: "signal.localhost",
});

export function localPublicOrigins(port = "4321") {
  const resolvedPort = resolveLocalBrowserPort(port);
  return Object.fromEntries(
    Object.entries(publicBrowserOrigins).map(([name, hostname]) => [name, `http://${hostname}:${resolvedPort}`]),
  );
}

export function validateLocalPublicBrowserBaseUrl(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== publicBrowserOrigins.marketing
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.port.length === 0
  ) {
    throw new Error("local_public_browser_gate_base_url_invalid");
  }
  resolveLocalBrowserPort(parsed.port);
  return parsed.origin;
}

export function validatePublicPlaywrightArguments(args) {
  if (args.length === 0) return [];
  const allowedProjects = new Set([
    "public-desktop-1440",
    "public-mobile-390",
    "public-zoom-200",
  ]);
  const updateSnapshotArgs = args.filter((arg) => arg === "--update-snapshots");
  const projectArgs = args.filter((arg) => arg.startsWith("--project="));
  if (
    updateSnapshotArgs.length <= 1
    && projectArgs.length === args.length - updateSnapshotArgs.length
    && projectArgs.every((arg) => allowedProjects.has(arg.slice("--project=".length)))
  ) {
    return [...args];
  }
  throw new Error("local_public_browser_gate_arguments_invalid");
}

export function buildLocalPublicCommandEnvironment({
  baseUrl,
  sourceEnvironment,
  stateDirectory,
  wranglerConfigPath,
}) {
  const environment = buildLocalCommandEnvironment({
    baseUrl,
    sourceEnvironment,
    stateDirectory,
    wranglerConfigPath,
  });
  return {
    ...environment,
    SELINOW_PUBLIC_BROWSER_BASE_URL: baseUrl,
    SELINOW_PUBLIC_BROWSER_MARKETING_ORIGIN: baseUrl,
    SELINOW_PUBLIC_BROWSER_DASHBOARD_ORIGIN: localPublicOrigins(new URL(baseUrl).port).dashboard,
    SELINOW_PUBLIC_BROWSER_STOREFRONT_ORIGIN: localPublicOrigins(new URL(baseUrl).port).storefront,
    WRANGLER_LOG_PATH: join(stateDirectory, "wrangler-public-browser.log"),
  };
}

export {
  assertIsolatedWranglerSecrets,
  assertOwnedDevServerStart,
  writeIsolatedDevVars,
  writeIsolatedWranglerConfig,
};
