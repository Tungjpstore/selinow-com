import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Phase 0 bootstrap", () => {
  it("contains the deploy entry points", async () => {
    await expect(access("astro.config.ts")).resolves.toBeUndefined();
    await expect(access("wrangler.jsonc")).resolves.toBeUndefined();
    await expect(access("src/pages/index.astro")).resolves.toBeUndefined();
  });
});
