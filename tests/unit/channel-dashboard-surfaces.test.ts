import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const CHANNEL_CODES = [
  "telegram.mini_app",
  "zalo.mini_app",
  "zalo.oa",
  "whatsapp.cloud",
  "discord.bot",
] as const;

describe("channel dashboard surfaces", () => {
  it("keeps each expansion in a stable, separately addressable dashboard surface", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/app/integrations.astro", "utf8"),
      readFile("src/scripts/dashboard/integrations.ts", "utf8"),
    ]);

    expect(page).toContain("channelSurfaceCatalog");
    expect(page).toContain("channel-surface-nav");
    expect(page).toContain("data-channel-placeholder");
    expect(page).toContain("channel-expansion-details");
    expect(page).toContain("channel.capabilities.length");
    expect(script).toContain("const channelSurfaceSlug");
    expect(script).toContain("card.id = `channel-${channelSurfaceSlug(expansion.code)}`");

    for (const code of CHANNEL_CODES) {
      expect(script, `${code} should have a name and safe visual identity`).toContain(code);
    }
  });

  it("renders provider state, stage, and seller next action without returning credentials", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/app/integrations.astro", "utf8"),
      readFile("src/scripts/dashboard/integrations.ts", "utf8"),
    ]);

    expect(script).toContain("const stageBadge");
    expect(script).toContain("card.dataset.stage = expansion.providerExecution");
    expect(script).toContain("card.dataset.status = request?.status ?? expansion.providerExecution");
    expect(script).toContain("channelExpansionRequiredAction");
    expect(script).toContain("requiredSellerAction(expansion.requiredSellerAction)");
    expect(script).toContain("capabilitiesDetails");
    expect(script).toContain("capabilitiesSummary.textContent");
    expect(script).toContain("request.requestPublicId");
    expect(script).toContain("const sellerActivationAllowed = expansion.sellerActivationAllowed;");
    expect(script).toContain('typeof object.sellerActivationAllowed !== "boolean"');
    expect(script).toContain("sellerActivationAllowed: object.sellerActivationAllowed");
    expect(script).toContain("sellerActivationAllowed && (request === null || request.status === \"canceled\" || request.status === \"rejected\")");
    expect(page).toContain("data-copy={JSON.stringify(integrationClientCopy)}");
    expect(page).not.toContain("data-channel-secret");
    expect(page).not.toContain("data-provider-token");
  });
});
