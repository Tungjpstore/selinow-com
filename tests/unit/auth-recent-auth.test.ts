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
  });

  it("enforces an explicitly requested platform-risk step-up window", () => {
    expect(() => { requireRecentAuth(auth, 5); }).toThrow("recent_auth_required");
    expect(() => { requireRecentAuth(auth, 60); }).toThrow("recent_auth_required");
  });
});
