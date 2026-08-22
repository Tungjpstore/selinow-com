import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspace = resolve(import.meta.dirname, "../..");

describe("marketing asset contracts", () => {
  it("keeps channel labels and readiness states outside raster assets", async () => {
    // LP editorial: the channel board lives in the CommerceCore section component.
    const core = await readFile(resolve(workspace, "src/components/marketing/sections/CommerceCore.astro"), "utf8");

    expect(core).toContain("data-channel-state={channel.state}");
    expect(core).toContain("destinations");
  });

  it("keeps global channel names localizable", async () => {
    const catalog = await readFile(resolve(workspace, "src/lib/i18n/catalogs/marketing.ts"), "utf8");

    for (const key of ["website", "telegram", "whatsapp", "zalo", "discord", "api"]) {
      expect(catalog).toContain(`marketing.home.channels.name.${key}`);
    }
  });

  it("ships the versioned text-free visual kit with complete SVG files", async () => {
    const assetDir = resolve(workspace, "public/brand/selinow-kit/global/v3");
    const expected = [
      "core-hub.svg",
      "hero-backdrop.svg",
      "flow-catalog.svg",
      "flow-channels.svg",
      "flow-support.svg",
      "flow-delivery.svg",
      "og-cover.svg",
    ];
    // v5 rebuild: workflow art is HTML/CSS; the core glyph stays the only kit
    // reference on the landing page. LP editorial keeps that reference in the
    // CommerceCore section component. The rest of the kit still ships intact.
    const core = await readFile(resolve(workspace, "src/components/marketing/sections/CommerceCore.astro"), "utf8");
    const referencedOnLanding = new Set([
      "core-hub.svg",
    ]);

    for (const file of expected) {
      const bytes = await readFile(resolve(assetDir, file));
      const source = bytes.toString("utf8");
      expect(source.trimStart().startsWith("<svg")).toBe(true);
      expect(source.trimEnd().endsWith("</svg>")).toBe(true);
      expect(source.length).toBeGreaterThan(1_000);
      if (referencedOnLanding.has(file)) {
        expect(core).toContain(`global/v3/${file}`);
      }
    }
  });

  it("renders a locale-neutral social cover as a valid JPEG", async () => {
    const layout = await readFile(resolve(workspace, "src/layouts/PlatformLayout.astro"), "utf8");
    const cover = await readFile(resolve(workspace, "public/brand/landing/v1/og-editorial.jpg"));

    // LP editorial campaign cover (nanobanana render composited with the
    // white logo) replaces the v5 PNG kit cover.
    expect(layout).toContain("brand/landing/v1/og-editorial.jpg");
    expect(cover.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(cover.subarray(-2).toString("hex")).toBe("ffd9");
    expect(cover.length).toBeGreaterThan(30_000);
  });
});
