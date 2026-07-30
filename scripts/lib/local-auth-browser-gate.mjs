import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { URL } from "node:url";

import { unstable_getVarsForDev, unstable_readConfig } from "wrangler";

export const localBrowserSecretNames = [
  "SESSION_SECRET",
  "MAGIC_LINK_SECRET",
  "IDENTIFIER_HMAC_SECRET",
  "CREDENTIAL_KEK_V1",
  "INVENTORY_KEK_V1",
  "EXPORT_KEK_V1",
  "TURNSTILE_SECRET_KEY",
];

const inheritedEnvironmentAllowlist = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
];

function absoluteProjectPath(repositoryRoot, value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return isAbsolute(value) ? value : resolve(repositoryRoot, value);
}

export function resolveLocalBrowserPort(value = "4321") {
  if (!/^\d{1,5}$/u.test(value)) throw new Error("local_auth_browser_gate_port_invalid");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("local_auth_browser_gate_port_invalid");
  }
  return String(port);
}

export function localBrowserBaseUrl(port) {
  return `http://app.localhost:${resolveLocalBrowserPort(port)}`;
}

export function validateLocalBrowserBaseUrl(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "app.localhost"
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.port.length === 0
  ) {
    throw new Error("local_auth_browser_gate_base_url_invalid");
  }
  resolveLocalBrowserPort(parsed.port);
  return parsed.origin;
}

export function buildIsolatedWranglerConfig(sourceConfig, repositoryRoot, baseUrl) {
  const validatedBaseUrl = validateLocalBrowserBaseUrl(baseUrl);
  const parsedBaseUrl = new URL(validatedBaseUrl);

  return {
    $schema: absoluteProjectPath(repositoryRoot, sourceConfig.$schema),
    name: `${sourceConfig.name}-auth-browser-local`,
    main: absoluteProjectPath(repositoryRoot, sourceConfig.main),
    compatibility_date: sourceConfig.compatibility_date,
    compatibility_flags: sourceConfig.compatibility_flags,
    assets: sourceConfig.assets === undefined
      ? undefined
      : {
          ...sourceConfig.assets,
          directory: absoluteProjectPath(repositoryRoot, sourceConfig.assets.directory),
        },
    d1_databases: sourceConfig.d1_databases?.map((database) => ({
      ...database,
      migrations_dir: absoluteProjectPath(repositoryRoot, database.migrations_dir),
    })),
    r2_buckets: sourceConfig.r2_buckets,
    kv_namespaces: sourceConfig.kv_namespaces,
    queues: sourceConfig.queues,
    secrets: {
      required: localBrowserSecretNames,
    },
    vars: {
      ...sourceConfig.vars,
      APP_ENV: "local",
      PLATFORM_BASE_DOMAIN: "localhost",
      PLATFORM_ORIGIN: `http://localhost:${parsedBaseUrl.port}`,
      DASHBOARD_ORIGIN: validatedBaseUrl,
      API_ORIGIN: `http://api.localhost:${parsedBaseUrl.port}`,
      CLOUDFLARE_ZONE_ID: "00000000000000000000000000000000",
      RESOURCE_MANIFEST_VERSION: "auth-browser-local",
      SAAS_CNAME_TARGET: "customers.localhost",
    },
  };
}

export function writeIsolatedWranglerConfig(repositoryRoot, stateDirectory, baseUrl) {
  const source = JSON.parse(readFileSync(join(repositoryRoot, "wrangler.jsonc"), "utf8"));
  const configPath = join(stateDirectory, "wrangler.auth-browser.json");
  const config = buildIsolatedWranglerConfig(source, repositoryRoot, baseUrl);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

export function writeIsolatedDevVars(stateDirectory, secretFactory) {
  const secrets = {};
  const lines = localBrowserSecretNames.map((name) => {
    const value = secretFactory();
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value)) {
      throw new Error("local_auth_browser_gate_secret_invalid");
    }
    secrets[name] = value;
    return `${name}=${value}`;
  });
  const devVarsPath = join(stateDirectory, ".dev.vars");
  writeFileSync(devVarsPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { devVarsPath, secrets };
}

export function assertIsolatedWranglerSecrets(configPath, expectedSecrets) {
  const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  const bindings = unstable_getVarsForDev(
    config.configPath,
    undefined,
    config.vars,
    undefined,
    true,
    config.secrets,
  );
  const actualSecretNames = Object.entries(bindings)
    .filter(([, binding]) => binding.type === "secret_text")
    .map(([name]) => name)
    .sort();
  const expectedSecretNames = Object.keys(expectedSecrets).sort();
  if (JSON.stringify(actualSecretNames) !== JSON.stringify(expectedSecretNames)) {
    throw new Error("local_auth_browser_gate_secret_bindings_invalid");
  }
  for (const [name, expected] of Object.entries(expectedSecrets)) {
    if (bindings[name]?.value !== expected) {
      throw new Error("local_auth_browser_gate_secret_bindings_invalid");
    }
  }
}

export function buildLocalCommandEnvironment({
  baseUrl,
  sourceEnvironment,
  stateDirectory,
  wranglerConfigPath,
}) {
  const environment = {};
  for (const name of inheritedEnvironmentAllowlist) {
    if (sourceEnvironment[name] !== undefined) environment[name] = sourceEnvironment[name];
  }

  Object.assign(environment, {
    APP_ENV: "local",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_VITE_FORCE_LOCAL: "true",
    SELINOW_AUTH_BROWSER_BASE_URL: baseUrl,
    SELINOW_AUTH_BROWSER_WRANGLER_CONFIG: wranglerConfigPath,
    SELINOW_LOCAL_STATE_DIR: stateDirectory,
    WRANGLER_LOG_PATH: join(stateDirectory, "wrangler.log"),
  });
  return environment;
}

export function validatePlaywrightArguments(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && args[0] === "--update-snapshots") return [...args];
  const allowedProjects = new Set([
    "kit-auth-desktop-1440",
    "kit-auth-tablet-768",
    "kit-auth-mobile-390",
    "kit-auth-minimum-320",
  ]);
  if (args.length > 0 && args.every((arg) => arg.startsWith("--project=") && allowedProjects.has(arg.slice("--project=".length)))) {
    return [...args];
  }
  throw new Error("local_auth_browser_gate_arguments_invalid");
}

export function assertOwnedDevServerStart(output, expectedPort) {
  if (output.includes("Dev server already running")) {
    throw new Error("local_auth_browser_gate_concurrent_run");
  }
  if (!output.includes("Dev server running")) {
    throw new Error("local_auth_browser_gate_dev_server_ownership_unknown");
  }
  if (expectedPort !== undefined) {
    const port = resolveLocalBrowserPort(expectedPort);
    if (!output.includes(`:${port}`)) {
      throw new Error("local_auth_browser_gate_port_mismatch");
    }
  }
}
