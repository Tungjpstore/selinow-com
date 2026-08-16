import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * Console v2 design contract — guards the rules that define the new language
 * (docs/DASHBOARD_REDESIGN_V2_PROPOSAL_2026-08-16.md §5):
 * one hairline border weight, working (≤600) font weights, and no emoji in
 * workspace UI. Scoped to the console surface only; legacy pages migrate in
 * P2 before this guard can be broadened.
 */

const CONSOLE_FILES = [
  "src/styles/console.css",
  "src/layouts/ConsoleLayout.astro",
  ...(await Array.fromAsync(glob("src/components/console/*.astro"))),
];

const EMOJI_RANGE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe("console design contract", () => {
  it("keeps every console surface on the single 1px hairline", async () => {
    for (const file of CONSOLE_FILES) {
      const source = await readFile(file, "utf8");
      const thickBorders = source.match(/border[a-z-]*:\s*(?!1px|0)[0-9.]+px/gu) ?? [];
      expect(thickBorders, `${file} declares non-hairline borders`).toEqual([]);
    }
  });

  it("caps console font weights at 600 (no display-black in the workspace)", async () => {
    for (const file of CONSOLE_FILES) {
      const source = await readFile(file, "utf8");
      const heavy = source.match(/font-weight:\s*(6[5-9]\d|[7-9]\d\d)\b/gu)
        ?? source.match(/\b(6[5-9]\d|[7-9]\d\d)\s\d+px\/\d+px/gu)
        ?? [];
      expect(heavy, `${file} uses display-grade font weights`).toEqual([]);
    }
  });

  it("keeps emoji out of console UI", async () => {
    for (const file of CONSOLE_FILES) {
      const source = await readFile(file, "utf8");
      expect(EMOJI_RANGE.test(source), `${file} contains emoji`).toBe(false);
    }
  });

  it("gives static console surfaces no elevation (shadow is for overlays/focus only)", async () => {
    const layout = await readFile("src/layouts/ConsoleLayout.astro", "utf8");
    const offenders = layout.split("\n")
      .filter((line) => /box-shadow:/.test(line))
      .filter((line) => !/box-shadow:\s*var\(--sln-console-(?:shadow-overlay|focus)\)/u.test(line));
    expect(offenders).toEqual([]);
  });
});
