import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspace = resolve(import.meta.dirname, "../..");

describe("marketing asset contracts", () => {
  it("keeps channel labels and readiness states outside raster assets", async () => {
    const landing = await readFile(resolve(workspace, "src/pages/index.astro"), "utf8");

    expect(landing).toContain("channelCards");
    expect(landing).toContain("data-channel-state={channel.state}");
    expect(landing).not.toMatch(/\/brand\/selinow-kit\/provider\.[^"]+\.png/u);
    expect(landing).not.toContain("/brand/selinow-kit/hero.selinow-core.png");
  });

  it("keeps global channel names localizable", async () => {
    const catalog = await readFile(resolve(workspace, "src/lib/i18n/catalogs/marketing.ts"), "utf8");

    for (const key of ["website", "telegram", "whatsapp", "zalo", "discord", "api"]) {
      expect(catalog).toContain(`marketing.home.channels.name.${key}`);
    }
  });

  it("ships the versioned text-free visual kit with complete SVG files", async () => {
    const landing = await readFile(resolve(workspace, "src/pages/index.astro"), "utf8");
    const assetDir = resolve(workspace, "public/brand/selinow-kit/global/v4");
    // How-it-works visuals are localized HTML product-UI mocks (HowItWorks.astro),
    // so the raster-free kit only carries the text-free core-hub + OG master.
    const expected = [
      "core-hub.svg",
      "og-cover.svg",
    ];

    for (const file of expected) {
      const bytes = await readFile(resolve(assetDir, file));
      const source = bytes.toString("utf8");
      expect(source.trimStart().startsWith("<svg")).toBe(true);
      expect(source.trimEnd().endsWith("</svg>")).toBe(true);
      expect(source.length).toBeGreaterThan(1_000);
    }
    expect(landing).toContain("global/v4/core-hub.svg");
  });

  it("renders a locale-neutral social cover as a valid PNG", async () => {
    const layout = await readFile(resolve(workspace, "src/layouts/PlatformLayout.astro"), "utf8");
    const cover = await readFile(resolve(workspace, "public/brand/selinow-og-cover-global.png"));

    expect(layout).toContain("selinow-og-cover-global.png");
    expect(cover.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(cover.subarray(-12).toString("hex")).toBe("0000000049454e44ae426082");
    expect(cover.length).toBeGreaterThan(100_000);
  });
});
