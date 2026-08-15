import { describe, expect, it } from "vitest";

import { createSensitiveRequestBody } from "../../src/lib/security/sensitive-request-body";

describe("sensitive request body", () => {
  it("releases both the mutable data field and serialized reference", () => {
    const value = { data: "license-key-plaintext", source: "paste" };
    const requestBody = createSensitiveRequestBody(value);

    expect(requestBody.serialized).toContain("license-key-plaintext");
    requestBody.clear();

    expect(value.data).toBe("");
    expect(requestBody.serialized).toBe("");
  });
});
