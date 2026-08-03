import { describe, expect, it } from "vitest";

import { createOpaqueToken } from "../../src/lib/core/ids";
import {
  hashZaloOfficialAccountOAuthState,
  verifyZaloOfficialAccountOAuthStateHash,
} from "../../src/lib/channels/zalo-oa-state";

const STATE = createOpaqueToken(32);
const BASE = {
  connectorRequestId: "creq-001",
  sessionSecret: "session-secret-123456",
  shopId: "shop-001",
  state: STATE,
};

describe("Zalo Official Account OAuth state binding", () => {
  it("hashes state with the tenant and connector scope and verifies in constant time", async () => {
    const expectedHash = await hashZaloOfficialAccountOAuthState(BASE);
    await expect(verifyZaloOfficialAccountOAuthStateHash({ ...BASE, expectedHash, receivedState: STATE })).resolves.toBeUndefined();
    expect(expectedHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(expectedHash).not.toContain(STATE);
  });

  it("changes the hash across tenant/request scopes and rejects replay/mismatch", async () => {
    const expectedHash = await hashZaloOfficialAccountOAuthState(BASE);
    const otherTenantHash = await hashZaloOfficialAccountOAuthState({ ...BASE, shopId: "shop-002" });
    const otherRequestHash = await hashZaloOfficialAccountOAuthState({ ...BASE, connectorRequestId: "creq-002" });
    expect(otherTenantHash).not.toBe(expectedHash);
    expect(otherRequestHash).not.toBe(expectedHash);
    await expect(verifyZaloOfficialAccountOAuthStateHash({ ...BASE, expectedHash, receivedState: createOpaqueToken(32) })).rejects.toMatchObject({ code: "zalo_oa_oauth_invalid", status: 400 });
    await expect(verifyZaloOfficialAccountOAuthStateHash({ ...BASE, expectedHash: otherTenantHash, receivedState: STATE })).rejects.toMatchObject({ code: "zalo_oa_oauth_invalid", status: 400 });
  });

  it("rejects unsafe state scopes and secrets before hashing", async () => {
    await expect(hashZaloOfficialAccountOAuthState({ ...BASE, shopId: "sh!" })).rejects.toMatchObject({ code: "zalo_oa_oauth_invalid", status: 400 });
    await expect(hashZaloOfficialAccountOAuthState({ ...BASE, sessionSecret: "short" })).rejects.toMatchObject({ code: "zalo_oa_oauth_invalid", status: 400 });
    await expect(hashZaloOfficialAccountOAuthState({ ...BASE, state: "not-a-state" })).rejects.toMatchObject({ code: "zalo_oa_oauth_invalid", status: 400 });
  });
});
