import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("rotation operator UI", () => {
  it("exposes guarded create/resume controls without plaintext fields", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/admin/operations.astro"), "utf8");

    expect(source).toContain("data-rotation-create-form");
    expect(source).toContain("ROTATE_GLOBAL");
    expect(source).toContain("ROTATE_LIVE");
    expect(source).toContain("data-rotation-process");
    expect(source).toContain("max=\"100\"");
    expect(source).not.toMatch(/name="[^"]*(?:ciphertext|plaintext|license)[^"]*"/iu);
  });
});
