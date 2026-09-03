import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("published legal and support surfaces", () => {
  it("links every policy surface from the public landing footer", () => {
    // The landing footer keeps the published policy pages reachable.
    const source = readFileSync(join(process.cwd(), "src/components/marketing/MarketingFooter.astro"), "utf8");
    expect(source).toContain('href={localizedPath("/legal")}');
    expect(source).toContain('href={localizedPath("/privacy")}');
    expect(source).toContain('href={localizedPath("/support")}');
  });

  it("publishes versioned owner-approved policy content", () => {
    for (const path of ["src/pages/privacy.astro", "src/pages/legal.astro", "src/pages/support.astro"]) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(source).toContain("PolicyDocument");
    }
    expect(readFileSync(join(process.cwd(), "src/components/marketing/PolicyDocument.astro"), "utf8")).toContain("Phiên bản 1");
  });
});
