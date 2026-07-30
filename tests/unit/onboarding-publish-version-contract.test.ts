import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("onboarding publish version contract", () => {
  it("sends the server-owned storefront settings version", async () => {
    const [script, route, store] = await Promise.all([
      readFile("src/scripts/dashboard/onboarding.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId]/catalog/publish.ts", "utf8"),
      readFile("src/lib/catalog/store.ts", "utf8"),
    ]);

    expect(script).toContain("state.onboarding.settings?.version");
    expect(script).toContain("JSON.stringify({ expectedVersion })");
    expect(route).toContain('rejectUnknownFields(body, ["expectedVersion"])');
    expect(route).toContain("storefront_version_invalid");
    expect(store).toContain("expectedStorefrontVersion: number");
  });
});
