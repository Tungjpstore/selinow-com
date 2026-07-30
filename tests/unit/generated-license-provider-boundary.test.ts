import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PROVIDER_MODULE = join(process.cwd(), "src/lib/commerce/generated-license-provider.ts");

function providerSource(): string {
  return readFileSync(PROVIDER_MODULE, "utf8");
}

describe("generated-license provider boundary", () => {
  it("keeps D1, application bindings, orchestration, and SQL mutations outside provider adapters", () => {
    const source = providerSource();
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)]
      .map((match) => match[1] ?? "");

    expect(source).not.toMatch(/\b(?:D1Database|AppBindings|PLATFORM_DB)\b/u);
    expect(source).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE)\b/iu);
    expect(source).not.toMatch(/\.prepare\s*\(|\.batch\s*\(/u);
    expect(imports).not.toEqual(expect.arrayContaining([
      "./generated-license",
      "../delivery/runtime",
      "../operations/dead-letters",
      "../../worker",
    ]));
    expect(imports.some((specifier) => /(?:store|operations|worker|generated-license(?:-crypto)?$)/u.test(specifier))).toBe(false);
  });

  it("limits every provider call to credential, endpoint, and the provider request", () => {
    const source = providerSource();
    const callType = source.match(/export type GeneratedLicenseProviderCall = Readonly<\{([\s\S]*?)\}>;/u)?.[1];

    expect(callType).toBeDefined();
    const fields = [...(callType ?? "").matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gmu)]
      .map((match) => match[1]);
    expect(fields).toEqual(["credential", "endpoint", "request"]);
    expect(callType).not.toMatch(/\b(?:database|db|env|binding|queue|artifact|shopId)\b/iu);
  });
});
