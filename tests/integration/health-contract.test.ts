import { describe, expect, it } from "vitest";

import { CANONICAL_COMMERCE_CONTRACT } from "../../src/lib/commerce/application";
import { TELEGRAM_CHANNEL_CODE, WEBSITE_CHANNEL_CODE } from "../../src/lib/channels/builtins";

describe("health response contract", () => {
  it("uses the platform API envelope", () => {
    const health = {
      ok: true,
      service: "selinow.com",
      phase: 10,
      release: {
        platform: "deployed",
        commerce: "provider_pending",
      },
      commerce: {
        channels: [TELEGRAM_CHANNEL_CODE, WEBSITE_CHANNEL_CODE],
        contract: CANONICAL_COMMERCE_CONTRACT,
      },
      requestId: "request-1234",
    } as const;

    expect(health.ok).toBe(true);
    expect(health.service).toBe("selinow.com");
    expect(health.phase).toBe(10);
    expect(health.release).toEqual({ platform: "deployed", commerce: "provider_pending" });
    expect(health.commerce).toEqual({
      channels: ["telegram", "website"],
      contract: "principal-channel-canonical-v1",
    });
    expect(health.requestId).not.toBe("");
  });
});
