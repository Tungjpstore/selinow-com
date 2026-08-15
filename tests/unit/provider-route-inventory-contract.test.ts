import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = resolve(import.meta.dirname, "../..");
const handoffInventory = join(workspace, "docs/frontend-rebuild-handoff/API_ENDPOINT_INDEX.csv");

const PROVIDER_ROUTE_PREFIXES = [
  "src/pages/api/app/shops/[shopPublicId]/channels/",
  "src/pages/api/app/shops/[shopPublicId]/integrations/telegram.ts",
  "src/pages/api/app/shops/[shopPublicId]/onboarding/channels.ts",
  "src/pages/api/channels/telegram-mini-app/",
  "src/pages/api/channels/zalo-oa/",
  "src/pages/webhooks/telegram/",
  "src/pages/webhooks/zalo-mini-app/",
  "src/pages/webhooks/zalo-oa/",
  "src/pages/webhooks/whatsapp/",
  "src/pages/webhooks/discord/",
] as const;

type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type InventoryRow = { method: RouteMethod; path: string; source: string };

function parseCsvRow(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === "," && !quoted) {
      values.push(value);
      value = "";
      continue;
    }
    value += character;
  }
  values.push(value);
  return values;
}

function readInventory(): InventoryRow[] {
  return readFileSync(handoffInventory, "utf8")
    .trim()
    .split(/\r?\n/u)
    .slice(1)
    .map(parseCsvRow)
    .map((row) => ({ method: row[0] as RouteMethod, path: row[1] ?? "", source: row[2] ?? "" }));
}

function routeSources(): string[] {
  const files: string[] = [];
  for (const prefix of PROVIDER_ROUTE_PREFIXES) {
    if (prefix.endsWith(".ts")) {
      files.push(prefix);
      continue;
    }
    const directory = join(workspace, prefix);
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const relativeDirectory = entry.parentPath.slice(workspace.length + 1);
      files.push(join(relativeDirectory, entry.name));
    }
  }
  return [...new Set(files)].sort();
}

function exportedMethods(source: string): RouteMethod[] {
  const text = readFileSync(join(workspace, source), "utf8");
  return [...text.matchAll(/export const (GET|POST|PUT|PATCH|DELETE): APIRoute/gu)].map((match) => match[1] as RouteMethod);
}

function inventoryKey(method: string, source: string): string {
  return `${method} ${source}`;
}

describe("provider/channel API route inventory", () => {
  it("keeps every provider route method indexed and every indexed provider route real", () => {
    const inventory = readInventory();
    const indexed = new Set(inventory.map((row) => inventoryKey(row.method, row.source)));
    const providerRows = inventory.filter((row) => PROVIDER_ROUTE_PREFIXES.some((prefix) => row.source.startsWith(prefix)));

    for (const source of routeSources()) {
      for (const method of exportedMethods(source)) {
        expect(indexed, `${method} ${source} is missing from the handoff inventory`).toContain(inventoryKey(method, source));
      }
    }
    for (const row of providerRows) {
      expect(row.method, `${row.source} has an invalid HTTP method`).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/u);
      expect(routeSources(), `${row.source} is orphaned in the handoff inventory`).toContain(row.source);
      expect(exportedMethods(row.source), `${row.method} ${row.source} is not exported by the route`).toContain(row.method);
    }
  });

  it("keeps dashboard connector mutations behind CSRF, recent-auth and idempotency guards", () => {
    const guardedRoutes = [
      "src/pages/api/app/shops/[shopPublicId]/channels/requests.ts",
      "src/pages/api/app/shops/[shopPublicId]/channels/credentials/index.ts",
      "src/pages/api/app/shops/[shopPublicId]/channels/requests/[requestPublicId].ts",
      "src/pages/api/app/shops/[shopPublicId]/channels/zalo-oa/oauth/start.ts",
    ] as const;
    for (const source of guardedRoutes) {
      const text = readFileSync(join(workspace, source), "utf8");
      expect(text, `${source} must require CSRF`).toContain("requireCsrfSession");
      expect(text, `${source} must require recent authentication`).toContain("requireRecentAuth");
    }
    expect(readFileSync(join(workspace, guardedRoutes[0]), "utf8")).toContain('request.headers.get("Idempotency-Key")');
    expect(readFileSync(join(workspace, guardedRoutes[1]), "utf8")).toContain('request.headers.get("Idempotency-Key")');
    expect(readFileSync(join(workspace, guardedRoutes[2]), "utf8")).toContain('request.headers.get("Idempotency-Key")');
  });

  it("keeps Telegram Mini App mutations tenant-session bound and rejects idempotency drift", () => {
    const files = [
      "src/pages/api/channels/telegram-mini-app/cart/[shopPublicId].ts",
      "src/pages/api/channels/telegram-mini-app/quote/[shopPublicId].ts",
      "src/pages/api/channels/telegram-mini-app/checkout/[shopPublicId].ts",
    ] as const;
    for (const source of files) {
      const text = readFileSync(join(workspace, source), "utf8");
      expect(text, `${source} must authenticate the Mini App session`).toContain("authenticateTelegramMiniAppSession");
      expect(text, `${source} must read a bearer token`).toContain("readTelegramMiniAppBearerToken");
      expect(text, `${source} must require an idempotency key`).toContain('request.headers.get("Idempotency-Key")');
    }
    for (const source of [files[0], files[2]]) {
      expect(readFileSync(join(workspace, source), "utf8"), `${source} must reject body/header idempotency drift`).toContain("idempotency_key_mismatch");
    }
  });

  it("keeps provider-pending webhook routes fail-closed before body consumption", () => {
    const zaloOaRoute = readFileSync(join(workspace, "src/pages/webhooks/zalo-oa/[connectionPublicId].ts"), "utf8");
    expect(zaloOaRoute).toContain("channel_provider_pending");
    expect(zaloOaRoute).not.toContain("request.text()");
    expect(zaloOaRoute).not.toContain("request.json()");

    const zaloMiniService = readFileSync(join(workspace, "src/lib/channels/zalo-mini-app-webhooks.ts"), "utf8");
    const pendingGuard = zaloMiniService.indexOf('contract.stage === "provider_pending"');
    const bodyRead = zaloMiniService.indexOf("const rawBody = await readBoundedBytes");
    expect(pendingGuard).toBeGreaterThanOrEqual(0);
    expect(bodyRead).toBeGreaterThan(pendingGuard);
  });

  it("keeps provider/channel route failures and successful projections non-public", () => {
    for (const source of routeSources()) {
      const text = readFileSync(join(workspace, source), "utf8");
      expect(text, `${source} must map failures through the safe error envelope`).toMatch(/create(?:Private)?CaughtErrorResponse/u);
      expect(text, `${source} must declare a private/no-store success policy or remain provider-pending`).toMatch(/PRIVATE_RESPONSE_HEADERS|Cache-Control|channel_provider_pending/u);
    }
  });
});
