import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * Console v2 design contract — guards the rules that define the new language
 * (docs/DASHBOARD_REDESIGN_V2_PROPOSAL_2026-08-16.md §5):
 * one hairline border weight, working (≤600) font weights, no emoji in
 * workspace UI, and token-only semantic color. Scope covers every seller,
 * admin, auth and shared dashboard surface; onboarding preview mocks are
 * exempt because their emoji model the seller's storefront/Telegram content,
 * not console UI (they carry explicit data-preview-* markers).
 */

const CONSOLE_FILES = [
  "src/styles/console.css",
  ...(await Array.fromAsync(glob("src/components/console/*.astro"))),
];

// Workspace-wide scopes: every seller/admin/auth page, both layouts, and all
// shared dashboard components (recursive — onboarding included).
const WORKSPACE_ASTRO = [
  ...(await Array.fromAsync(glob("src/pages/app/**/*.astro"))),
  ...(await Array.fromAsync(glob("src/pages/admin/*.astro"))),
  "src/pages/login.astro",
  "src/pages/register.astro",
  "src/pages/forgot-password.astro",
  "src/layouts/AppLayout.astro",
  "src/layouts/AdminLayout.astro",
  ...(await Array.fromAsync(glob("src/components/dashboard/**/*.astro"))),
];
// Chrome/skin stylesheets that must obey the same hairline/weight/hex rules.
const WORKSPACE_CSS = [
  "src/styles/auth.css",
  "src/styles/admin.css",
  "src/styles/app-shell.css",
];
const ONBOARDING_PREVIEW_MOCKS = /data-preview-product-icon|mock-product-emoji|mock-logo-icon|data-preview-mock/;

const EMOJI_RANGE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const THICK_BORDER = /\bborder(?:-top|-right|-bottom|-left|-width)?:\s*(?:[2-9]|1\.5)px/u;

describe("console design contract", () => {
  it("keeps every console surface on the single 1px hairline", async () => {
    for (const file of CONSOLE_FILES) {
      const source = await readFile(file, "utf8");
      const thickBorders = source.match(/border[a-z-]*:\s*(?!1px|0)[0-9.]+px/gu) ?? [];
      expect(thickBorders, `${file} declares non-hairline borders`).toEqual([]);
    }
  });

  it("flattens every workspace border to the 1px hairline (P2 sweep)", async () => {
    for (const file of [...WORKSPACE_ASTRO, ...WORKSPACE_CSS]) {
      const source = await readFile(file, "utf8");
      const offenders = source.split("\n").filter((line) => THICK_BORDER.test(line));
      expect(offenders, `${file} still has >1px borders`).toEqual([]);
    }
  });

  it("caps font weights at 600 across the console and the workspace", async () => {
    for (const file of [...CONSOLE_FILES, ...WORKSPACE_ASTRO, ...WORKSPACE_CSS]) {
      const source = await readFile(file, "utf8");
      const heavy = source.match(/font-weight:\s*(6[5-9]\d|[7-9]\d\d)\b/gu)
        ?? source.match(/\b(6[5-9]\d|[7-9]\d\d)\s\d+px\/\d+px/gu)
        ?? [];
      expect(heavy, `${file} uses display-grade font weights`).toEqual([]);
    }
  });

  it("keeps emoji out of console UI and workspace pages", async () => {
    for (const file of [...CONSOLE_FILES, ...WORKSPACE_ASTRO]) {
      const source = await readFile(file, "utf8");
      const visibleEmoji = source
        .split("\n")
        .filter((line) => !ONBOARDING_PREVIEW_MOCKS.test(line))
        .some((line) => EMOJI_RANGE.test(line));
      expect(visibleEmoji, `${file} contains emoji`).toBe(false);
    }
  });

  it("keeps semantic colors on tokens — raw hex only for brand/channel accents and preview mocks", async () => {
    const brandOrMock = /--channel-accent|--merchant-|brand|telegram|zalo|whatsapp|discord|mock|preview/i;
    const hex = /#[0-9a-fA-F]{6}\b/;
    for (const file of [...WORKSPACE_ASTRO, ...WORKSPACE_CSS]) {
      const source = await readFile(file, "utf8");
      const offenders = source.split("\n")
        .filter((line) => hex.test(line))
        .filter((line) => !brandOrMock.test(line))
        .filter((line) => !/content=/.test(line)); // <meta theme-color> values
      expect(offenders, `${file} uses raw semantic hex`).toEqual([]);
    }
  });

  it("gives static console surfaces no elevation (shadow is for overlays/focus only)", async () => {
    // After shell convergence the console chrome lives in app-shell.css.
    // Legacy shadow tokens are remapped to `none` inside .app-shell, and the
    // only live shadows may come from the console overlay/focus tokens.
    const shellCss = await readFile("src/styles/app-shell.css", "utf8");
    const offenders = shellCss.split("\n")
      .filter((line) => /box-shadow:/.test(line))
      .filter((line) => !/box-shadow:\s*var\(--sln-console-(?:shadow-overlay|focus)\)/u.test(line))
      .filter((line) => !/box-shadow:\s*var\(--sln-shadow-(?:xs|sm)\)/u.test(line));
    expect(offenders).toEqual([]);
  });
});
