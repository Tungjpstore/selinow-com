import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("production trigger CLI contract", () => {
  it("forwards the parsed production confirmation into the mutation ceremony", async () => {
    const source = await readFile("scripts/production-trigger.mjs", "utf8");
    const ceremonyCall = source.match(/executeProductionTriggerCeremony\(\{(?<input>[\s\S]*?)\n\s*\}\);/u);

    expect(ceremonyCall?.groups?.input).toContain("confirmProduction: options.confirmProduction");
  });
});
