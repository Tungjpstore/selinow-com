import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  consumeGoogleOAuthState,
  exchangeAndVerifyGoogleCode,
  issueGoogleOAuthState,
  resetGoogleJwksCache,
  resolveGoogleIdentity,
  revokeGoogleOAuthState,
} from "../../src/lib/auth/google";
import { hmacToken } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const CLIENT_ID = "selinow-google-client.apps.googleusercontent.com";
const REDIRECT_URI = "https://app.selinow.com/api/auth/google/callback";
const BROWSER_BINDING = "B".repeat(43);
const OTHER_BROWSER_BINDING = "C".repeat(43);
const CODE_VERIFIER = "V".repeat(43);
const NONCE = "N".repeat(43);
const USER_A = "usr-google-core-a";
const USER_B = "usr-google-core-b";

type GoogleTestClaims = {
  aud: string | string[];
  azp?: string;
  email: string;
  email_verified: boolean | string;
  exp: number;
  iat: number;
  iss: string;
  name?: string;
  nonce: string;
  sub: string;
};

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- D1 .all<T>() shape
  all<T>(): Promise<{ results: T[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) as T[] });
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function seedUsers(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES
      (?, 'existing-a@example.test', 'Existing A', 'active', ?, ?),
      (?, 'existing-b@example.test', 'Existing B', 'active', ?, ?)
  `).run(USER_A, NOW.toISOString(), NOW.toISOString(), USER_B, NOW.toISOString(), NOW.toISOString());
}

function bindings(database: SqliteD1): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    APP_ENV: "local",
    CREDENTIAL_KEK_V1: "A".repeat(43),
    DASHBOARD_ORIGIN: "https://app.selinow.com",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret-for-tests",
    GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
    IDENTIFIER_HMAC_SECRET: "google-identity-hmac-secret-for-tests",
    PLATFORM_DB: database,
    SESSION_COOKIE_NAME: "selinow_session",
    SESSION_SECRET: "google-state-session-secret-for-tests",
  } as unknown as AppBindings;
}

function baseClaims(overrides: Partial<GoogleTestClaims> = {}): GoogleTestClaims {
  return {
    aud: CLIENT_ID,
    email: "seller@example.test",
    email_verified: true,
    exp: NOW_SECONDS + 600,
    iat: NOW_SECONDS - 30,
    iss: "https://accounts.google.com",
    name: "Seller Example",
    nonce: NONCE,
    sub: "123456789012345678901",
    ...overrides,
  };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function signIdToken(
  privateKey: CryptoKey,
  claims: GoogleTestClaims,
  header: Record<string, unknown> = { alg: "RS256", kid: "google-test-key", typ: "JWT" },
): Promise<string> {
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

function providerFetcher(input: {
  idToken: string;
  jwk: JsonWebKey & { kid: string };
  jwksFailure?: Error;
  tokenFailure?: Error;
}): typeof fetch {
  return (resource: RequestInfo | URL) => {
    const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.toString() : resource.url;
    if (url === "https://oauth2.googleapis.com/token") {
      if (input.tokenFailure !== undefined) return Promise.reject(input.tokenFailure);
      return Promise.resolve(Response.json({
        access_token: "provider-access-token-must-not-be-used",
        id_token: input.idToken,
        refresh_token: "provider-refresh-token-must-not-be-used",
      }));
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      if (input.jwksFailure !== undefined) return Promise.reject(input.jwksFailure);
      return Promise.resolve(Response.json({ keys: [input.jwk] }));
    }
    return Promise.reject(new Error(`unexpected_fetch:${url}`));
  };
}

let signingKeys: CryptoKeyPair;
let signingJwk: JsonWebKey & { kid: string };

beforeAll(async () => {
  signingKeys = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  signingJwk = {
    ...await crypto.subtle.exportKey("jwk", signingKeys.publicKey),
    alg: "RS256",
    kid: "google-test-key",
    use: "sig",
  };
});

describe("Google OAuth state", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seedUsers(database);
    env = bindings(new SqliteD1(database));
  });

  afterEach(() => {
    database.close();
  });

  it("binds state to PKCE and the browser without storing raw transient values", async () => {
    const issued = await issueGoogleOAuthState({
      ...env,
      browserBinding: BROWSER_BINDING,
      flow: "login",
      now: NOW,
      returnTo: "/app/orders",
    });
    const authorizationUrl = new URL(issued.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    const nonce = authorizationUrl.searchParams.get("nonce");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid email profile");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("select_account");

    if (state === null || nonce === null) throw new Error("google_state_test_setup_invalid");
    const pending = database.prepare("SELECT * FROM auth_google_oauth_states").get() as Record<string, unknown>;
    const serializedPending = JSON.stringify(pending);
    expect(pending.state_lookup_hash).not.toBe(state);
    expect(pending.nonce_hash).not.toBe(nonce);
    expect(pending.browser_binding_hash).not.toBe(BROWSER_BINDING);
    expect(serializedPending).not.toContain(state);
    expect(serializedPending).not.toContain(nonce);
    expect(serializedPending).not.toContain(BROWSER_BINDING);

    const consumed = await consumeGoogleOAuthState({
      ...env,
      browserBinding: BROWSER_BINDING,
      now: new Date(NOW.getTime() + 1_000),
      receivedState: state,
    });
    const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(consumed.verifier));
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(Buffer.from(challengeBytes).toString("base64url"));
    expect(consumed).toMatchObject({
      flow: "login",
      nonce,
      redirectUri: REDIRECT_URI,
      returnTo: "/app/orders",
    });
    expect(String(pending.code_verifier_ciphertext_b64)).not.toContain(consumed.verifier);
    expect(consumed.verifier).toMatch(/^[A-Za-z0-9._~-]{43}$/u);

    expect(database.prepare(`
      SELECT status, nonce_hash AS nonceHash, browser_binding_hash AS browserHash,
        code_verifier_ciphertext_b64 AS ciphertext, code_verifier_iv_b64 AS iv
      FROM auth_google_oauth_states
    `).get()).toEqual({
      browserHash: null,
      ciphertext: null,
      iv: null,
      nonceHash: null,
      status: "consumed",
    });
    await expect(consumeGoogleOAuthState({
      ...env,
      browserBinding: BROWSER_BINDING,
      now: new Date(NOW.getTime() + 2_000),
      receivedState: state,
    })).rejects.toMatchObject({ code: "google_oauth_state_replay", status: 409 });
  });

  it("rejects a different browser and expiration without consuming state", async () => {
    const issued = await issueGoogleOAuthState({
      ...env,
      browserBinding: BROWSER_BINDING,
      flow: "register",
      now: NOW,
    });
    const state = new URL(issued.authorizationUrl).searchParams.get("state");
    if (state === null) throw new Error("google_state_test_setup_invalid");

    await expect(consumeGoogleOAuthState({
      ...env,
      browserBinding: OTHER_BROWSER_BINDING,
      now: new Date(NOW.getTime() + 1_000),
      receivedState: state,
    })).rejects.toMatchObject({ code: "google_oauth_browser_mismatch", status: 403 });
    expect(database.prepare("SELECT status FROM auth_google_oauth_states").get()).toEqual({ status: "pending" });

    await expect(consumeGoogleOAuthState({
      ...env,
      browserBinding: BROWSER_BINDING,
      now: new Date(NOW.getTime() + 11 * 60_000),
      receivedState: state,
    })).rejects.toMatchObject({ code: "google_oauth_state_expired", status: 409 });
    expect(database.prepare("SELECT status FROM auth_google_oauth_states").get()).toEqual({ status: "pending" });
  });

  it("revokes a cancelled provider callback and clears transient fields", async () => {
    const issued = await issueGoogleOAuthState({
      ...env,
      browserBinding: BROWSER_BINDING,
      flow: "login",
      now: NOW,
    });
    const state = new URL(issued.authorizationUrl).searchParams.get("state");
    if (state === null) throw new Error("google_state_test_setup_invalid");
    await expect(revokeGoogleOAuthState({
      ...env,
      browserBinding: BROWSER_BINDING,
      now: new Date(NOW.getTime() + 1_000),
      receivedState: state,
    })).resolves.toMatchObject({ flow: "login", returnTo: "/app" });
    expect(database.prepare("SELECT status, nonce_hash, browser_binding_hash, code_verifier_ciphertext_b64 FROM auth_google_oauth_states").get()).toEqual({
      status: "revoked",
      nonce_hash: null,
      browser_binding_hash: null,
      code_verifier_ciphertext_b64: null,
    });
  });
});

describe("Google ID token verification", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    resetGoogleJwksCache();
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    env = bindings(new SqliteD1(database));
  });

  afterEach(() => {
    database.close();
  });

  it("accepts a valid Google RS256 ID token with a numeric provider subject", async () => {
    const claims = baseClaims();
    const idToken = await signIdToken(signingKeys.privateKey, claims);
    const verified = await exchangeAndVerifyGoogleCode({
      ...env,
      code: "one-use-google-authorization-code",
      fetcher: providerFetcher({ idToken, jwk: signingJwk }),
      nonce: NONCE,
      now: NOW,
      verifier: CODE_VERIFIER,
    });
    expect(verified).toMatchObject(claims);
  });

  it.each([
    ["issuer", { iss: "https://attacker.example" }],
    ["audience", { aud: "another-client.apps.googleusercontent.com" }],
    ["authorized party", { azp: "another-client.apps.googleusercontent.com" }],
    ["nonce", { nonce: "X".repeat(43) }],
    ["expiration", { exp: NOW_SECONDS }],
    ["future issued-at", { iat: NOW_SECONDS + 121 }],
    ["verified email", { email_verified: false }],
    ["provider subject", { sub: "subject with spaces" }],
  ] satisfies Array<[string, Partial<GoogleTestClaims>]>)("rejects an invalid %s claim", async (_name, overrides) => {
    const idToken = await signIdToken(signingKeys.privateKey, baseClaims(overrides));
    await expect(exchangeAndVerifyGoogleCode({
      ...env,
      code: "one-use-google-authorization-code",
      fetcher: providerFetcher({ idToken, jwk: signingJwk }),
      nonce: NONCE,
      now: NOW,
      verifier: CODE_VERIFIER,
    })).rejects.toMatchObject({ code: "google_oauth_provider_failed", status: 401 });
  });

  it("rejects an unknown key, invalid signature, and non-RS256 header", async () => {
    const unknownKeyToken = await signIdToken(signingKeys.privateKey, baseClaims(), {
      alg: "RS256",
      kid: "unknown-google-key",
      typ: "JWT",
    });
    await expect(exchangeAndVerifyGoogleCode({
      ...env,
      code: "one-use-google-authorization-code",
      fetcher: providerFetcher({ idToken: unknownKeyToken, jwk: signingJwk }),
      nonce: NONCE,
      now: NOW,
      verifier: CODE_VERIFIER,
    })).rejects.toMatchObject({ code: "google_oauth_provider_failed", status: 401 });

    resetGoogleJwksCache();
    const invalidSignatureToken = await signIdToken(signingKeys.privateKey, baseClaims({ email: "changed-after-signing@example.test" }));
    const [headerPart, , signaturePart] = invalidSignatureToken.split(".");
    if (headerPart === undefined || signaturePart === undefined) throw new Error("google_jwt_test_setup_invalid");
    const tamperedClaims = encodeJson(baseClaims());
    const tampered = `${headerPart}.${tamperedClaims}.${signaturePart}`;
    await expect(exchangeAndVerifyGoogleCode({
      ...env,
      code: "one-use-google-authorization-code",
      fetcher: providerFetcher({ idToken: tampered, jwk: signingJwk }),
      nonce: NONCE,
      now: NOW,
      verifier: CODE_VERIFIER,
    })).rejects.toMatchObject({ code: "google_oauth_provider_failed", status: 401 });

    resetGoogleJwksCache();
    const wrongAlgorithmToken = await signIdToken(signingKeys.privateKey, baseClaims(), {
      alg: "HS256",
      kid: "google-test-key",
      typ: "JWT",
    });
    await expect(exchangeAndVerifyGoogleCode({
      ...env,
      code: "one-use-google-authorization-code",
      fetcher: providerFetcher({ idToken: wrongAlgorithmToken, jwk: signingJwk }),
      nonce: NONCE,
      now: NOW,
      verifier: CODE_VERIFIER,
    })).rejects.toMatchObject({ code: "google_oauth_provider_failed", status: 401 });
  });

  it("maps token and JWKS network failures to a provider-safe application error", async () => {
    const idToken = await signIdToken(signingKeys.privateKey, baseClaims());
    await expect(exchangeAndVerifyGoogleCode({
      ...env,
      code: "one-use-google-authorization-code",
      fetcher: providerFetcher({ idToken, jwk: signingJwk, tokenFailure: new Error("network secret detail") }),
      nonce: NONCE,
      now: NOW,
      verifier: CODE_VERIFIER,
    })).rejects.toMatchObject({ code: "google_oauth_provider_failed", status: 502 });

    resetGoogleJwksCache();
    await expect(exchangeAndVerifyGoogleCode({
      ...env,
      code: "one-use-google-authorization-code",
      fetcher: providerFetcher({ idToken, jwk: signingJwk, jwksFailure: new Error("network secret detail") }),
      nonce: NONCE,
      now: NOW,
      verifier: CODE_VERIFIER,
    })).rejects.toMatchObject({ code: "google_oauth_provider_failed", status: 502 });
  });
});

describe("Google account identity resolution", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seedUsers(database);
    env = bindings(new SqliteD1(database));
  });

  afterEach(() => {
    database.close();
  });

  it("registers a new user, hashes the provider subject, and resolves later login", async () => {
    const claims = baseClaims({
      email: "  New.Seller@Example.Test ",
      name: "  New   Seller  ",
      sub: "109876543210987654321",
    });
    const registered = await resolveGoogleIdentity({ ...env, allowCreate: true, claims, now: NOW });
    expect(registered.created).toBe(true);
    expect(registered.email).toBe("new.seller@example.test");
    expect(registered.displayName).toBe("New Seller");

    const identity = database.prepare(`
      SELECT user_id AS userId, subject_hash AS subjectHash, subject_key_version AS keyVersion
      FROM auth_google_identities WHERE id = ?
    `).get(registered.identityId) as { keyVersion: string; subjectHash: string; userId: string };
    expect(identity).toEqual({
      keyVersion: "v1",
      subjectHash: await hmacToken(env.IDENTIFIER_HMAC_SECRET, "google-subject:v1", claims.sub),
      userId: registered.userId,
    });
    expect(JSON.stringify(identity)).not.toContain(claims.sub);
    expect(database.prepare(`
      SELECT email_normalized AS email, display_name AS displayName, status, email_verified_at AS verifiedAt
      FROM platform_users WHERE id = ?
    `).get(registered.userId)).toEqual({
      displayName: "New Seller",
      email: "new.seller@example.test",
      status: "active",
      verifiedAt: NOW.toISOString(),
    });

    const loggedIn = await resolveGoogleIdentity({
      ...env,
      claims,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(loggedIn).toMatchObject({
      created: false,
      identityId: registered.identityId,
      userId: registered.userId,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM platform_users WHERE email_normalized = ?")
      .get("new.seller@example.test")).toEqual({ count: 1 });
  });

  it("provisions on Google login and attaches a verified Gmail to an existing account", async () => {
    database.prepare(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run("usr-google-pending", "pending@example.test", "Pending Seller", NOW.toISOString(), NOW.toISOString());

    await expect(resolveGoogleIdentity({
      ...env,
      allowCreate: true,
      claims: baseClaims({ email: "missing@example.test", sub: "google-missing-account" }),
      now: NOW,
    })).resolves.toMatchObject({ created: true, email: "missing@example.test" });

    const linked = await resolveGoogleIdentity({
      ...env,
      allowCreate: true,
      claims: baseClaims({ email: "existing-a@example.test", sub: "google-existing-email" }),
      now: NOW,
    });
    expect(linked).toMatchObject({ created: false, userId: USER_A });

    const pending = await resolveGoogleIdentity({
      ...env,
      allowCreate: true,
      claims: baseClaims({ email: "pending@example.test", sub: "google-pending-email" }),
      now: NOW,
    });
    expect(pending).toMatchObject({ created: false, userId: "usr-google-pending" });
    expect(database.prepare(`SELECT status, email_verified_at AS verifiedAt FROM platform_users WHERE id = ?`)
      .get("usr-google-pending")).toEqual({ status: "active", verifiedAt: NOW.toISOString() });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_google_identities").get()).toEqual({ count: 3 });

    database.prepare("UPDATE platform_users SET status = 'pending', email_verified_at = NULL WHERE id = ?")
      .run("usr-google-pending");
    const retry = await resolveGoogleIdentity({
      ...env,
      allowCreate: true,
      claims: baseClaims({ email: "pending@example.test", sub: "google-pending-email" }),
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(retry).toMatchObject({ created: false, userId: "usr-google-pending" });
    expect(database.prepare(`SELECT status, email_verified_at AS verifiedAt FROM platform_users WHERE id = ?`)
      .get("usr-google-pending")).toEqual({ status: "active", verifiedAt: new Date(NOW.getTime() + 1_000).toISOString() });

    const sameNow = new Date(NOW.getTime() + 2_000);
    await expect(resolveGoogleIdentity({
      ...env,
      allowCreate: true,
      claims: baseClaims({ email: "pending@example.test", sub: "google-pending-email" }),
      now: sameNow,
    })).resolves.toMatchObject({ userId: "usr-google-pending" });
    await expect(resolveGoogleIdentity({
      ...env,
      allowCreate: true,
      claims: baseClaims({ email: "pending@example.test", sub: "google-pending-email" }),
      now: sameNow,
    })).resolves.toMatchObject({ userId: "usr-google-pending" });

    database.prepare(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'suspended', ?, ?)
    `).run("usr-google-suspended", "suspended@example.test", "Suspended Seller", NOW.toISOString(), NOW.toISOString());
    await expect(resolveGoogleIdentity({
      ...env,
      allowCreate: true,
      claims: baseClaims({ email: "suspended@example.test", sub: "google-suspended-email" }),
      now: sameNow,
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_google_identities WHERE user_id = ?")
      .get("usr-google-suspended")).toEqual({ count: 0 });
  });

  it("keeps the legacy explicit-link guard when provisioning is disabled", async () => {
    await expect(resolveGoogleIdentity({
      ...env,
      claims: baseClaims({ email: "missing@example.test", sub: "google-missing-account" }),
      now: NOW,
    })).rejects.toMatchObject({ code: "google_account_not_found", status: 404 });
    await expect(resolveGoogleIdentity({
      ...env,
      claims: baseClaims({ email: "existing-a@example.test", sub: "google-existing-email" }),
      now: NOW,
    })).rejects.toMatchObject({ code: "google_account_link_required", status: 409 });
  });

  it("links only the initiated account and fences identity collisions", async () => {
    const claims = baseClaims({ email: "different-google-email@example.test", sub: "google-link-subject" });
    const linked = await resolveGoogleIdentity({
      ...env,
      claims,
      initiatedUserId: USER_A,
      now: NOW,
    });
    expect(linked).toMatchObject({ created: false, userId: USER_A });

    const idempotentLink = await resolveGoogleIdentity({
      ...env,
      claims,
      initiatedUserId: USER_A,
      now: new Date(NOW.getTime() + 500),
    });
    expect(idempotentLink).toMatchObject({
      created: false,
      identityId: linked.identityId,
      userId: USER_A,
    });

    await expect(resolveGoogleIdentity({
      ...env,
      claims,
      initiatedUserId: USER_B,
      now: new Date(NOW.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "google_identity_in_use", status: 409 });
    await expect(resolveGoogleIdentity({
      ...env,
      claims: baseClaims({ email: "second-google@example.test", sub: "second-google-subject" }),
      initiatedUserId: USER_A,
      now: new Date(NOW.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "google_already_linked", status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_google_identities").get()).toEqual({ count: 1 });
  });
});
