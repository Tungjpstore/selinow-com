import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CHANNEL_EXPANSION_CATALOG } from "../../src/lib/channels/expansion";
import { getProviderRuntimeContract } from "../../src/lib/channels/provider-contracts";

const workspace = resolve(import.meta.dirname, "../..");

// Keep the provider catalog, runtime contract and route surface in lockstep.
// A provider may remain provider-pending, but its safe boundary must not be
// advertised without a concrete route or Mini App entry point.
const ROUTE_SOURCES: Record<string, readonly string[]> = {
  "telegram.mini_app": [
    "src/pages/api/channels/telegram-mini-app/sessions/[shopPublicId].ts",
    "src/pages/api/channels/telegram-mini-app/catalog/[shopPublicId].ts",
    "src/pages/api/channels/telegram-mini-app/cart/[shopPublicId].ts",
    "src/pages/api/channels/telegram-mini-app/quote/[shopPublicId].ts",
    "src/pages/api/channels/telegram-mini-app/checkout/[shopPublicId].ts",
    "src/pages/api/channels/telegram-mini-app/orders/[shopPublicId].ts",
    "src/pages/api/channels/telegram-mini-app/orders/[shopPublicId]/[orderId].ts",
  ],
  "zalo.mini_app": ["src/pages/webhooks/zalo-mini-app/[connectionPublicId].ts"],
  "zalo.oa": [
    "src/pages/webhooks/zalo-oa/[connectionPublicId].ts",
    "src/pages/api/app/shops/[shopPublicId]/channels/zalo-oa/oauth/start.ts",
    "src/pages/api/channels/zalo-oa/callback.ts",
  ],
  "whatsapp.cloud": ["src/pages/webhooks/whatsapp/[connectionPublicId].ts"],
  "discord.bot": ["src/pages/webhooks/discord/[connectionPublicId].ts"],
};

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

describe("provider surface audit", () => {
  it("keeps every expansion manifest backed by a runtime contract and route", () => {
    for (const expansion of CHANNEL_EXPANSION_CATALOG) {
      const contract = getProviderRuntimeContract(expansion.providerCode);
      expect(contract.code).toBe(expansion.providerCode);
      expect(ROUTE_SOURCES[expansion.code]).toBeDefined();
      for (const source of ROUTE_SOURCES[expansion.code] ?? []) {
        expect(existsSync(resolve(workspace, source))).toBe(true);
      }
    }
  });

  it("keeps the integrations UI wired to all connector boundary endpoints", () => {
    const page = readFileSync(resolve(workspace, "src/pages/app/integrations.astro"), "utf8");
    const script = readFileSync(resolve(workspace, "src/scripts/dashboard/integrations.ts"), "utf8");
    expect(page).toContain("data-channel-expansion-section");
    expect(script).toContain('const base = `/api/app/shops/${encodeURIComponent(shopPublicId)}/channels`');
    expect(script).toContain('requestApi(`${base}/catalog`)');
    expect(script).toContain('requestApi(`${base}/requests`)');
    expect(script).toContain("channelExpansionNameTelegram");
    expect(script).toContain("channelExpansionNameZalo");
    expect(script).toContain("channelExpansionNameZaloOa");
    expect(script).toContain("channelExpansionNameWhatsapp");
    expect(script).toContain("channelExpansionNameDiscord");
  });

  it("keeps every documented API source path present in the repository", () => {
    const rows = readFileSync(resolve(workspace, "docs/frontend-rebuild-handoff/API_ENDPOINT_INDEX.csv"), "utf8")
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map(parseCsvRow);
    expect(rows).toHaveLength(215);



    for (const row of rows) {
      const source = row[2];
      expect(typeof source).toBe("string");
      if (source !== undefined && source.length > 0) expect(existsSync(resolve(workspace, source))).toBe(true);
    }


    const inventory = rows.map((row) => row[1] ?? "").join("\n");
    expect(inventory).toContain("/webhooks/discord/:connectionPublicId");
    expect(inventory).toContain("/webhooks/whatsapp/:connectionPublicId");
    expect(inventory).toContain("/webhooks/zalo-mini-app/:connectionPublicId");
    expect(inventory).toContain("/webhooks/zalo-oa/:connectionPublicId");
    expect(inventory).toContain("/api/channels/zalo-oa/callback");
    expect(inventory).toContain("/api/channels/telegram-mini-app/sessions/:shopPublicId");
    expect(inventory).toContain("/api/channels/telegram-mini-app/cart/:shopPublicId");
    expect(inventory).toContain("/api/channels/telegram-mini-app/checkout/:shopPublicId");
    expect(inventory).toContain("/api/channels/telegram-mini-app/orders/:shopPublicId/:orderId");
    expect(inventory).toContain("/api/auth/login-2fa");
    expect(inventory).toContain("/api/auth/google/start");
    expect(inventory).toContain("/api/auth/google/callback");
    expect(inventory).toContain("/api/auth/google/2fa");
    expect(inventory).toContain("/api/app/account/enable-2fa-request");
    expect(inventory).toContain("/api/app/account/enable-2fa-verify");
    expect(inventory).toContain("/api/app/account/disable-2fa");
    expect(inventory).toContain("/api/app/account/disable-2fa-request");
    expect(inventory).toContain("/api/app/account/change-password");
    expect(inventory).toContain("/api/app/account/login-history");
    expect(inventory).toContain("/api/app/shops/:shopPublicId/billing/checkouts/:checkoutSessionId");
    expect(inventory).toContain("/api/admin/operations");
    expect(inventory).toContain("/api/admin/operations/dead-letters/:deadLetterId");
    expect(inventory).toContain("/api/admin/operations/deletions/:deletionRequestId/legal-hold");
    expect(inventory).toContain("/api/admin/operations/incidents/:incidentId");
    expect(inventory).toContain("/api/admin/operations/rotations");
    expect(inventory).toContain("/api/admin/operations/rotations/:runId/process");
  });

  it("does not leave an API or webhook route orphaned from the handoff inventory", () => {
    const rows = readFileSync(resolve(workspace, "docs/frontend-rebuild-handoff/API_ENDPOINT_INDEX.csv"), "utf8")
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map(parseCsvRow);
    const indexedSources = new Set(rows.map((row) => row[2]).filter((source): source is string => typeof source === "string"));
    const routeFiles = execFileSync("find", ["src/pages/api", "src/pages/webhooks", "-type", "f", "-name", "*.ts"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .filter((source) => source.length > 0);
    expect(routeFiles.filter((source) => !indexedSources.has(source))).toEqual([]);
  });
});
