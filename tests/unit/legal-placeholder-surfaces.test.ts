import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("owner-approval placeholder surfaces", () => {
  it("links every blocked policy surface from the public landing footer", () => {
    // The landing delegates its footer to MarketingFooter (landing v4).
    const source = readFileSync(join(process.cwd(), "src/components/marketing/MarketingFooter.astro"), "utf8");
    expect(source).toContain('localizedPath("/legal")');
    expect(source).toContain('localizedPath("/privacy")');
    expect(source).toContain('localizedPath("/support")');
  });

  it("keeps privacy, legal and support claims explicitly blocked", () => {
    for (const path of ["src/pages/privacy.astro", "src/pages/legal.astro", "src/pages/support.astro"]) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(source.toLowerCase()).toMatch(/blocked|not approved/iu);
      expect(source.toLowerCase()).toMatch(/owner approval|owner-approved/iu);
    }
  });
});
