import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function telegramSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return telegramSourceFiles(path);
    return /\.(?:astro|ts)$/u.test(entry.name) && /telegram/iu.test(path) ? [path] : [];
  });
}

describe("Telegram localization source contract", () => {
  it("does not hardcode vi-VN into runtime Intl or toLocale formatting", () => {
    const hardcodedLocaleFormatting = /(?:Intl\.(?:NumberFormat|DateTimeFormat)\s*\(\s*["']vi-VN["']|toLocale(?:String|DateString|TimeString)\s*\(\s*["']vi-VN["'])/u;
    const sourceFiles = telegramSourceFiles(join(process.cwd(), "src"));

    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const file of sourceFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(hardcodedLocaleFormatting);
    }
  });
});
