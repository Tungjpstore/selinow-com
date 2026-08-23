import { describe, expect, it } from "vitest";

import { requireRecentAuth, type AuthContext } from "../../src/lib/auth/session";

const auth: AuthContext = {
  authenticatedAt: "2020-01-01T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.com",
  sessionId: "session-1",
  userId: "user-1",
};

describe("recent authentication policy", () => {
  it("does not reject an active authenticated session based on its age", () => {
    expect(() => { requireRecentAuth(auth); }).not.toThrow();
    expect(() => { requireRecentAuth(auth, 5); }).not.toThrow();
  });
});
