import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  alertEmail: vi.fn(),
  env: { APP_ENV: "staging", SESSION_COOKIE_NAME: "selinow_session" },
  passwordService: vi.fn(),
  recent: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/email", () => ({
  sendPasswordChangedAlertEmail: dependencies.alertEmail,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recent,
}));

vi.mock("../../src/lib/auth/password", () => ({
  changePassword: dependencies.passwordService,
}));

import { hashPassword, verifyPassword } from "../../src/lib/core/crypto";
import type { AuthContext } from "../../src/lib/auth/session";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { POST as ChangePasswordPOST } from "../../src/pages/api/app/account/change-password";

type ChangePasswordFn = (input: {
  auth: AuthContext;
  currentPassword: string;
  env: AppBindings;
  newPassword: string;
}) => Promise<{ revokedSessionCount: number }>;

const USER_ID = "usr-pwd";
const SESSION_CURRENT = "ses-current";
const CURRENT_PASSWORD = "CurrentPassword123!";
const NEW_PASSWORD = "NewPassword456!";

type MockSession = { id: string; status: string; userId: string };

const auth: AuthContext = {
  authenticatedAt: "2026-08-15T11:55:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Seller",
  email: "seller@selinow.com",
  sessionId: SESSION_CURRENT,
  userId: USER_ID,
};

function makeEnv(passwordHash: string, sessions: MockSession[], status = "active") {
  const user = { passwordHash, status };
  const observed = { revokeSql: "", revokedBoundSessionId: "" };

  const makeStatement = (query: string, boundArgs: readonly unknown[] = []) => ({
    all: () => Promise.resolve({ results: [] }),
    bind: (...args: readonly unknown[]) => makeStatement(query, args),
    first: <T>() => {
      if (query.includes("FROM platform_users")) {
        return Promise.resolve({ passwordHash: user.passwordHash, status: user.status } as T);
      }
      return Promise.resolve(null as T);
    },
    run: () => {
      if (query.includes("UPDATE platform_users SET password_hash")) {
        const [newHash] = boundArgs as [string];
        user.passwordHash = newHash;
        return Promise.resolve({ meta: { changes: 1 } });
      }
      if (query.includes("UPDATE auth_sessions")) {
        observed.revokeSql = query;
        const [revokedAt, userId, keepSessionId] = boundArgs as [string, string, string];
        observed.revokedBoundSessionId = keepSessionId;
        void revokedAt;
        let changes = 0;
        for (const session of sessions) {
          if (session.userId === userId && session.status === "active" && session.id !== keepSessionId) {
            session.status = "revoked";
            changes += 1;
          }
        }
        return Promise.resolve({ meta: { changes } });
      }
      return Promise.resolve({ meta: { changes: 0 } });
    },
  });

  const batch = vi.fn(async (statements: readonly { run: () => Promise<{ meta: { changes: number } }> }[]) => {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  });

  const env = {
    APP_ENV: "staging",
    PLATFORM_DB: {
      batch,
      prepare: vi.fn((query: string) => makeStatement(query)),
    },
  } as unknown as AppBindings;

  return { batch, env, observed, sessions, user };
}

describe("account password change service", () => {
  let realChangePassword: ChangePasswordFn;

  beforeAll(async () => {
    const real = await vi.importActual<{ changePassword: ChangePasswordFn }>("../../src/lib/auth/password");
    realChangePassword = real.changePassword;
  });

  beforeEach(() => {
    dependencies.alertEmail.mockReset();
    dependencies.alertEmail.mockResolvedValue(undefined);
  });

  it("updates the hash, revokes other sessions, and keeps the current session alive", async () => {
    const sessions: MockSession[] = [
      { id: SESSION_CURRENT, status: "active", userId: USER_ID },
      { id: "ses-other-1", status: "active", userId: USER_ID },
      { id: "ses-other-2", status: "active", userId: USER_ID },
      { id: "ses-already-revoked", status: "revoked", userId: USER_ID },
      { id: "ses-other-user", status: "active", userId: "usr-other" },
    ];
    const fixture = makeEnv(await hashPassword(CURRENT_PASSWORD), sessions);

    const result = await realChangePassword({
      auth,
      currentPassword: CURRENT_PASSWORD,
      env: fixture.env,
      newPassword: NEW_PASSWORD,
    });

    expect(result.revokedSessionCount).toBe(2);
    // Revocation targets every other active session, never the current one.
    expect(fixture.observed.revokeSql).toContain("id != ?");
    expect(fixture.observed.revokedBoundSessionId).toBe(SESSION_CURRENT);
    expect(sessions.find((s) => s.id === SESSION_CURRENT)?.status).toBe("active");
    expect(sessions.find((s) => s.id === "ses-other-1")?.status).toBe("revoked");
    expect(sessions.find((s) => s.id === "ses-other-2")?.status).toBe("revoked");
    expect(sessions.find((s) => s.id === "ses-other-user")?.status).toBe("active");

    await expect(verifyPassword(NEW_PASSWORD, fixture.user.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword(CURRENT_PASSWORD, fixture.user.passwordHash)).resolves.toBe(false);
    expect(dependencies.alertEmail).toHaveBeenCalledWith(expect.objectContaining({ email: auth.email }));
  });

  it("rejects a wrong current password without touching sessions", async () => {
    const fixture = makeEnv(await hashPassword(CURRENT_PASSWORD), [
      { id: SESSION_CURRENT, status: "active", userId: USER_ID },
      { id: "ses-other-1", status: "active", userId: USER_ID },
    ]);

    await expect(realChangePassword({
      auth,
      currentPassword: "WrongPassword123!",
      env: fixture.env,
      newPassword: NEW_PASSWORD,
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["current_password_invalid"], status: 400 });

    expect(fixture.sessions.find((s) => s.id === "ses-other-1")?.status).toBe("active");
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("rejects a new password identical to the current one", async () => {
    const fixture = makeEnv(await hashPassword(CURRENT_PASSWORD), []);

    await expect(realChangePassword({
      auth,
      currentPassword: CURRENT_PASSWORD,
      env: fixture.env,
      newPassword: CURRENT_PASSWORD,
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["password_same_as_current"] });
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("enforces password strength before touching the database", async () => {
    const fixture = makeEnv(await hashPassword(CURRENT_PASSWORD), []);

    await expect(realChangePassword({
      auth,
      currentPassword: CURRENT_PASSWORD,
      env: fixture.env,
      newPassword: "weak",
    })).rejects.toMatchObject({ code: "validation_failed" });
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("blocks suspended accounts", async () => {
    const fixture = makeEnv(await hashPassword(CURRENT_PASSWORD), [], "suspended");

    await expect(realChangePassword({
      auth,
      currentPassword: CURRENT_PASSWORD,
      env: fixture.env,
      newPassword: NEW_PASSWORD,
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });
  });
});

describe("POST /api/app/account/change-password route", () => {
  function context(body: unknown) {
    return {
      locals: { locale: "en-US", requestId: "request-change-password" },
      request: new Request("https://app.example.test/api/app/account/change-password", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    } as unknown as Parameters<typeof ChangePasswordPOST>[0];
  }

  beforeEach(() => {
    dependencies.passwordService.mockReset();
    dependencies.recent.mockReset();
    dependencies.requireCsrf.mockReset();
    dependencies.requireCsrf.mockResolvedValue(auth);
  });

  it("requires recent authentication and reports the revoked session count", async () => {
    dependencies.passwordService.mockResolvedValue({ revokedSessionCount: 3 });

    const response = await ChangePasswordPOST(context({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));

    expect(dependencies.recent).toHaveBeenCalledWith(auth);
    expect(dependencies.passwordService).toHaveBeenCalledWith(expect.objectContaining({
      auth,
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      requestId: "request-change-password",
      revokedSessionCount: 3,
    });
  });

  it("rejects missing, oversized or unknown fields before calling the service", async () => {
    for (const body of [
      {},
      { currentPassword: CURRENT_PASSWORD },
      { newPassword: NEW_PASSWORD },
      { currentPassword: "", newPassword: NEW_PASSWORD },
      { currentPassword: "x".repeat(129), newPassword: NEW_PASSWORD },
      { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, hint: "x" },
    ]) {
      const response = await ChangePasswordPOST(context(body));
      expect(response.status).toBe(400);
    }
    expect(dependencies.passwordService).not.toHaveBeenCalled();
  });

  it("returns 403 when recent authentication is stale", async () => {
    dependencies.recent.mockImplementationOnce(() => {
      throw new AppError("recent_auth_required", 403);
    });

    const response = await ChangePasswordPOST(context({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));

    expect(response.status).toBe(403);
    expect(dependencies.passwordService).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "recent_auth_required" });
  });

  it("forwards service failures such as current_password_invalid", async () => {
    dependencies.passwordService.mockRejectedValue(new AppError("validation_failed", 400, ["current_password_invalid"]));

    const response = await ChangePasswordPOST(context({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_failed",
      issues: ["current_password_invalid"],
    });
  });
});
