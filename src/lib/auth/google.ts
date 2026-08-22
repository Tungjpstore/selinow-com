import { AppError } from "../core/errors";
import { constantTimeEqual, hmacToken } from "../core/crypto";
import { createId, createOpaqueToken, toBase64Url } from "../core/ids";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../crypto/keyring";
import { safeRelativeRedirect } from "./redirect";
import type { AppBindings } from "../platform/bindings";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const STATE_TTL_MS = 10 * 60_000;
const SAFE_VALUE = /^[A-Za-z0-9_-]{43,128}$/u;
const SAFE_CODE_VERIFIER = /^[A-Za-z0-9._~-]{43}$/u;
const SAFE_SUBJECT = /^[A-Za-z0-9._:-]{1,255}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

type GoogleBindings = Pick<AppBindings, "APP_ENV" | "CREDENTIAL_KEK_V1" | "CREDENTIAL_KEK_V2" | "ACTIVE_CREDENTIAL_KEY_VERSION" | "CREDENTIAL_KEY_VERSION" | "DASHBOARD_ORIGIN" | "GOOGLE_OAUTH_CLIENT_ID" | "GOOGLE_OAUTH_CLIENT_SECRET" | "GOOGLE_OAUTH_REDIRECT_URI" | "IDENTIFIER_HMAC_SECRET" | "PLATFORM_DB" | "SESSION_SECRET">;

type StateRow = {
  browserBindingHash: string | null;
  codeVerifierCiphertextB64: string | null;
  codeVerifierIvB64: string | null;
  expiresAt: string;
  flow: "link" | "login" | "register";
  id: string;
  keyVersion: string | null;
  nonceHash: string | null;
  redirectUri: string;
  returnTo: string | null;
  stateLookupHash: string;
  status: "consumed" | "pending" | "revoked";
  version: number;
  initiatedUserId: string | null;
};

type GoogleClaims = {
  aud: string | string[];
  azp?: string;
  email?: string;
  email_verified?: boolean | string;
  exp: number;
  iat: number;
  iss: string;
  nonce?: string;
  sub: string;
  name?: string;
};

type GoogleIdentityResult = {
  created: boolean;
  displayName: string;
  email: string;
  identityId: string;
  userId: string;
};

let cachedJwks: { expiresAt: number; keys: readonly JsonWebKey[] } | null = null;

function invalid(issue: string): never {
  throw new AppError("google_oauth_invalid", 400, [issue]);
}

function providerFailure(issue: string, status = 502): never {
  throw new AppError("google_oauth_provider_failed", status, [issue]);
}

function requireString(value: unknown, issue: string, max = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid(issue);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) invalid(issue);
  }
  return value;
}

function requireToken(value: unknown, issue: string): string {
  const token = requireString(value, issue, 128);
  if (!SAFE_VALUE.test(token)) invalid(issue);
  return token;
}

function decodeBase64Url(value: string, issue: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) invalid(issue);
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    invalid(issue);
  }
}

function decodeJson(value: string, issue: string): unknown {
  try {
    return JSON.parse(decoder.decode(decodeBase64Url(value, issue))) as unknown;
  } catch {
    invalid(issue);
  }
}

function timestamp(value: Date | undefined): string {
  const date = value ?? new Date();
  if (!Number.isFinite(date.getTime())) invalid("time_invalid");
  return date.toISOString();
}

function monotonicTimestamp(candidate: string, previous: string): string {
  const candidateMs = Date.parse(candidate);
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(previousMs)) return candidate;
  return new Date(Math.max(candidateMs, previousMs + 1)).toISOString();
}

function stateLookupHash(env: Pick<GoogleBindings, "SESSION_SECRET">, state: string): Promise<string> {
  return hmacToken(env.SESSION_SECRET, "google-oauth-state-lookup:v1", state);
}

function subjectHash(env: Pick<GoogleBindings, "IDENTIFIER_HMAC_SECRET">, subject: string): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, "google-subject:v1", subject);
}

function nonceHash(env: Pick<GoogleBindings, "SESSION_SECRET">, nonce: string): Promise<string> {
  return hmacToken(env.SESSION_SECRET, "google-oauth-nonce:v1", nonce);
}

function browserBindingHash(env: Pick<GoogleBindings, "SESSION_SECRET">, binding: string): Promise<string> {
  return hmacToken(env.SESSION_SECRET, "google-oauth-browser:v1", binding);
}

function stateAad(id: string, keyVersion: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`google-oauth-state\0${keyVersion}\0${id}`);
}

function keyBytes(kek: string): Uint8Array<ArrayBuffer> {
  const value = decodeBase64Url(kek, "key_invalid");
  if (value.byteLength !== 32) invalid("key_invalid");
  return value;
}

async function encryptTransient(input: { id: string; keyVersion: string; kek: string; nonce: string; verifier: string }): Promise<{ ciphertextB64: string; ivB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes(input.kek), { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = encoder.encode(JSON.stringify({ nonce: input.nonce, verifier: input.verifier }));
  const ciphertext = await crypto.subtle.encrypt({ additionalData: stateAad(input.id, input.keyVersion), iv, name: "AES-GCM", tagLength: 128 }, key, plaintext);
  return { ciphertextB64: toBase64Url(new Uint8Array(ciphertext)), ivB64: toBase64Url(iv) };
}

async function decryptTransient(input: { ciphertextB64: string; id: string; ivB64: string; keyVersion: string; kek: string }): Promise<{ nonce: string; verifier: string }> {
  const ciphertext = decodeBase64Url(input.ciphertextB64, "ciphertext_invalid");
  const iv = decodeBase64Url(input.ivB64, "iv_invalid");
  if (ciphertext.byteLength < 16 || iv.byteLength !== 12) invalid("envelope_invalid");
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes(input.kek), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ additionalData: stateAad(input.id, input.keyVersion), iv, name: "AES-GCM", tagLength: 128 }, key, ciphertext);
    const value = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
    const nonce = requireToken(value.nonce, "nonce_invalid");
    const verifier = requireString(value.verifier, "code_verifier_invalid", 128);
    if (!SAFE_CODE_VERIFIER.test(verifier)) invalid("code_verifier_invalid");
    return { nonce, verifier };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("google_oauth_state_decryption_failed", 500);
  }
}

async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = createOpaqueToken(32);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return { challenge: toBase64Url(new Uint8Array(digest)), verifier };
}

function clientConfig(env: GoogleBindings): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = requireString(env.GOOGLE_OAUTH_CLIENT_ID, "client_id_missing", 256);
  const clientSecret = requireString(env.GOOGLE_OAUTH_CLIENT_SECRET, "client_secret_missing", 512);
  const redirectUri = requireString(env.GOOGLE_OAUTH_REDIRECT_URI, "redirect_uri_missing", 2048);
  let parsed: URL;
  try { parsed = new URL(redirectUri); } catch { invalid("redirect_uri_invalid"); }
  if (parsed.protocol !== "https:" && !(env.APP_ENV === "local" && parsed.protocol === "http:" && parsed.hostname === "localhost")) invalid("redirect_uri_invalid");
  if (parsed.username || parsed.password || parsed.hash) invalid("redirect_uri_invalid");
  return { clientId, clientSecret, redirectUri };
}

function userDisplayName(claims: GoogleClaims): string {
  const candidate = typeof claims.name === "string" ? claims.name.trim().replace(/\s+/gu, " ") : "";
  if (candidate.length > 0 && candidate.length <= 80) return candidate;
  return claims.email?.split("@", 1)[0]?.slice(0, 80) || "Seller";
}

function normalizeGoogleEmail(value: unknown): string {
  if (typeof value !== "string") providerFailure("email_missing", 401);
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) providerFailure("email_invalid", 401);
  return email;
}

async function loadState(env: GoogleBindings, lookupHash: string): Promise<StateRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id, flow, initiated_user_id AS initiatedUserId, state_lookup_hash AS stateLookupHash,
      nonce_hash AS nonceHash, browser_binding_hash AS browserBindingHash,
      redirect_uri AS redirectUri, return_to AS returnTo,
      code_verifier_ciphertext_b64 AS codeVerifierCiphertextB64,
      code_verifier_iv_b64 AS codeVerifierIvB64, key_version AS keyVersion,
      status, expires_at AS expiresAt, version
    FROM auth_google_oauth_states
    WHERE state_lookup_hash = ? LIMIT 1
  `).bind(lookupHash).first<StateRow>();
}

async function refreshGoogleIdentity(input: GoogleBindings & { identityId: string; now: string }): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await input.PLATFORM_DB.prepare(`
      SELECT version, last_authenticated_at AS lastAuthenticatedAt,
        updated_at AS updatedAt
      FROM auth_google_identities WHERE id = ? LIMIT 1
    `).bind(input.identityId).first<{ lastAuthenticatedAt: string; updatedAt: string; version: number }>();
    if (row === null) throw new AppError("authentication_required", 401);
    const authenticatedAt = monotonicTimestamp(input.now, row.lastAuthenticatedAt);
    const updatedAt = monotonicTimestamp(input.now, row.updatedAt);
    try {
      const mutation = await input.PLATFORM_DB.prepare(`
        UPDATE auth_google_identities
        SET last_authenticated_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).bind(authenticatedAt, updatedAt, input.identityId, row.version).run();
      if (mutation.meta.changes === 1) return;
    } catch {
      // A concurrent callback may trip the immutable timestamp guard. Reload
      // the row and retry against its latest version.
    }
  }
  throw new AppError("google_identity_refresh_conflict", 409);
}

async function loadPendingState(input: GoogleBindings & { now?: Date; receivedState: string; browserBinding: string }): Promise<{ lookup: string; now: string; row: StateRow }> {
  const receivedState = requireToken(input.receivedState, "state_invalid");
  const browserBinding = input.browserBinding;
  const now = timestamp(input.now);
  const lookup = await stateLookupHash(input, receivedState);
  const row = await loadState(input, lookup);
  if (row === null) throw new AppError("google_oauth_state_not_found", 404);
  if (row.status !== "pending") throw new AppError("google_oauth_state_replay", 409);
  const expiresAt = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new AppError("google_oauth_state_invalid", 500);
  if (expiresAt <= Date.parse(now)) throw new AppError("google_oauth_state_expired", 409);
  if (!SAFE_VALUE.test(browserBinding)) throw new AppError("google_oauth_browser_mismatch", 403);
  const expectedBrowser = await browserBindingHash(input, browserBinding);
  if (row.browserBindingHash === null || !constantTimeEqual(expectedBrowser, row.browserBindingHash)) throw new AppError("google_oauth_browser_mismatch", 403);
  return { lookup, now, row };
}

export async function issueGoogleOAuthState(input: GoogleBindings & { flow: "link" | "login" | "register"; initiatedUserId?: string; now?: Date; returnTo?: string; browserBinding: string }): Promise<{ authorizationUrl: string; browserBinding: string; expiresAt: string; flow: StateRow["flow"] }> {
  const config = clientConfig(input);
  if ((input.flow === "link") !== (input.initiatedUserId !== undefined)) invalid("initiating_user_invalid");
  const now = timestamp(input.now);
  const expiresAt = new Date(Date.parse(now) + STATE_TTL_MS).toISOString();
  const fallback = input.flow === "link" ? "/app/security?tab=sessions" : input.flow === "register" ? "/onboarding" : "/app";
  const returnTo = safeRelativeRedirect(input.returnTo ?? null, fallback);
  const state = createOpaqueToken(32);
  const nonce = createOpaqueToken(32);
  const browserBinding = requireToken(input.browserBinding, "browser_binding_invalid");
  const { challenge, verifier } = await createPkce();
  const id = createId("gos");
  const activeKey = resolveActiveEncryptionKey(input, "credential");
  const encrypted = await encryptTransient({ id, keyVersion: activeKey.version, kek: activeKey.kek, nonce, verifier });
  const [lookup, nonceDigest, browserDigest] = await Promise.all([
    stateLookupHash(input, state), nonceHash(input, nonce), browserBindingHash(input, browserBinding),
  ]);
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  await input.PLATFORM_DB.prepare(`
    INSERT INTO auth_google_oauth_states (
      id, flow, initiated_user_id, state_lookup_hash, nonce_hash, browser_binding_hash,
      redirect_uri, return_to, code_verifier_ciphertext_b64, code_verifier_iv_b64,
      key_version, status, expires_at, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1)
  `).bind(id, input.flow, input.initiatedUserId ?? null, lookup, nonceDigest, browserDigest, config.redirectUri, returnTo, encrypted.ciphertextB64, encrypted.ivB64, activeKey.version, expiresAt, now, now).run();
  return { authorizationUrl: url.toString(), browserBinding, expiresAt, flow: input.flow };
}

export async function consumeGoogleOAuthState(input: GoogleBindings & { now?: Date; receivedState: string; browserBinding: string }): Promise<{ flow: StateRow["flow"]; nonce: string; redirectUri: string; returnTo: string; verifier: string; initiatedUserId: string | null }> {
  const { now, row } = await loadPendingState(input);
  if (row.codeVerifierCiphertextB64 === null || row.codeVerifierIvB64 === null || row.keyVersion === null || row.nonceHash === null) throw new AppError("google_oauth_state_invalid", 500);
  const key = resolveEncryptionKey(input, "credential", row.keyVersion);
  const transient = await decryptTransient({ ciphertextB64: row.codeVerifierCiphertextB64, id: row.id, ivB64: row.codeVerifierIvB64, keyVersion: key.version, kek: key.kek });
  const expectedNonce = await nonceHash(input, transient.nonce);
  if (!constantTimeEqual(expectedNonce, row.nonceHash)) throw new AppError("google_oauth_state_invalid", 500);
  const mutation = await input.PLATFORM_DB.prepare(`
    UPDATE auth_google_oauth_states
    SET status = 'consumed', consumed_at = ?, updated_at = ?, version = version + 1,
      nonce_hash = NULL, browser_binding_hash = NULL,
      code_verifier_ciphertext_b64 = NULL, code_verifier_iv_b64 = NULL
    WHERE id = ? AND state_lookup_hash = ? AND status = 'pending' AND expires_at > ? AND version = ?
  `).bind(now, now, row.id, row.stateLookupHash, now, row.version).run();
  if (mutation.meta.changes !== 1) throw new AppError("google_oauth_state_replay", 409);
  const fallback = row.flow === "link" ? "/app/security?tab=sessions" : row.flow === "register" ? "/onboarding" : "/app";
  return { flow: row.flow, initiatedUserId: row.initiatedUserId, nonce: transient.nonce, redirectUri: row.redirectUri, returnTo: safeRelativeRedirect(row.returnTo, fallback), verifier: transient.verifier };
}

export async function revokeGoogleOAuthState(input: GoogleBindings & { now?: Date; receivedState: string; browserBinding: string }): Promise<{ flow: StateRow["flow"]; returnTo: string }> {
  const { lookup, now, row } = await loadPendingState(input);
  const mutation = await input.PLATFORM_DB.prepare(`
    UPDATE auth_google_oauth_states
    SET status = 'revoked', revoked_at = ?, updated_at = ?, version = version + 1,
      nonce_hash = NULL, browser_binding_hash = NULL,
      code_verifier_ciphertext_b64 = NULL, code_verifier_iv_b64 = NULL
    WHERE id = ? AND state_lookup_hash = ? AND status = 'pending' AND expires_at > ? AND version = ?
  `).bind(now, now, row.id, lookup, now, row.version).run();
  if (mutation.meta.changes !== 1) throw new AppError("google_oauth_state_replay", 409);
  const fallback = row.flow === "link" ? "/app/security?tab=sessions" : row.flow === "register" ? "/onboarding" : "/app";
  return { flow: row.flow, returnTo: safeRelativeRedirect(row.returnTo, fallback) };
}

function parseJwt(value: string): { header: Record<string, unknown>; claims: GoogleClaims; signingInput: string; signature: Uint8Array<ArrayBuffer> } {
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) providerFailure("id_token_invalid", 401);
  const [headerPart, claimsPart, signaturePart] = parts;
  if (headerPart === undefined || claimsPart === undefined || signaturePart === undefined) providerFailure("id_token_invalid", 401);
  const headerValue = decodeJson(headerPart, "id_token_header_invalid");
  const claimsValue = decodeJson(claimsPart, "id_token_claims_invalid");
  if (typeof headerValue !== "object" || headerValue === null || Array.isArray(headerValue)
    || typeof claimsValue !== "object" || claimsValue === null || Array.isArray(claimsValue)) providerFailure("id_token_invalid", 401);
  const header = headerValue as Record<string, unknown>;
  const claims = claimsValue as unknown as GoogleClaims;
  const signature = decodeBase64Url(signaturePart, "id_token_signature_invalid");
  return { claims, header, signature, signingInput: `${headerPart}.${claimsPart}` };
}

async function googleJwks(fetcher: typeof fetch): Promise<readonly JsonWebKey[]> {
  if (cachedJwks !== null && cachedJwks.expiresAt > Date.now()) return cachedJwks.keys;
  let response: Response;
  try {
    response = await fetcher(GOOGLE_JWKS_ENDPOINT, { headers: { Accept: "application/json" } });
  } catch {
    providerFailure("jwks_unavailable");
  }
  if (!response.ok) providerFailure("jwks_unavailable");
  let payload: { keys?: unknown };
  try {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) providerFailure("jwks_invalid");
    payload = value;
  } catch {
    providerFailure("jwks_invalid");
  }
  if (!Array.isArray(payload.keys)) providerFailure("jwks_invalid");
  const keys = payload.keys.filter((value): value is JsonWebKey => typeof value === "object" && value !== null && (value as JsonWebKey).kty === "RSA");
  if (keys.length === 0) providerFailure("jwks_empty");
  cachedJwks = { expiresAt: Date.now() + 60 * 60_000, keys };
  return keys;
}

async function verifyGoogleIdToken(input: { clientId: string; fetcher: typeof fetch; idToken: string; nonce: string; now: Date }): Promise<GoogleClaims> {
  const parsed = parseJwt(input.idToken);
  if (parsed.header.alg !== "RS256" || typeof parsed.header.kid !== "string") providerFailure("id_token_algorithm_invalid", 401);
  const jwk = (await googleJwks(input.fetcher)).find((candidate) => (candidate as JsonWebKey & { kid?: string }).kid === parsed.header.kid);
  if (jwk === undefined) providerFailure("id_token_key_unknown", 401);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" }, false, ["verify"]);
  } catch {
    providerFailure("id_token_key_invalid", 401);
  }
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify({ hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" }, key, parsed.signature, encoder.encode(parsed.signingInput));
  } catch {
    providerFailure("id_token_signature_invalid", 401);
  }
  if (!valid) providerFailure("id_token_signature_invalid", 401);
  const claims = parsed.claims;
  const nowSeconds = Math.floor(input.now.getTime() / 1_000);
  const audienceValid = Array.isArray(claims.aud) ? claims.aud.includes(input.clientId) : claims.aud === input.clientId;
  const multipleAudiences = Array.isArray(claims.aud) && claims.aud.length > 1;
  if (!GOOGLE_ISSUERS.has(claims.iss) || !audienceValid || (multipleAudiences && claims.azp !== input.clientId)
    || (claims.azp !== undefined && claims.azp !== input.clientId)
    || !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds || !Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds + 120
    || typeof claims.sub !== "string" || !SAFE_SUBJECT.test(claims.sub)
    || typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, input.nonce)) providerFailure("id_token_claims_invalid", 401);
  if (claims.email_verified !== true) providerFailure("email_not_verified", 401);
  normalizeGoogleEmail(claims.email);
  return claims;
}

async function exchangeCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string; fetcher: typeof fetch }): Promise<string> {
  const payload = new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, code_verifier: input.verifier, grant_type: "authorization_code", redirect_uri: input.redirectUri });
  let response: Response;
  try {
    response = await input.fetcher(GOOGLE_TOKEN_ENDPOINT, { body: payload, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, method: "POST" });
  } catch {
    providerFailure("token_exchange_failed");
  }
  if (!response.ok) providerFailure("token_exchange_failed");
  let body: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) providerFailure("token_response_invalid");
    body = value as Record<string, unknown>;
  } catch {
    providerFailure("token_response_invalid");
  }
  if (typeof body.id_token !== "string" || body.id_token.length > 16_384) providerFailure("id_token_missing");
  return body.id_token;
}

export async function exchangeAndVerifyGoogleCode(input: GoogleBindings & { code: string; nonce: string; now?: Date; verifier: string; fetcher?: typeof fetch }): Promise<GoogleClaims> {
  const config = clientConfig(input);
  const code = requireString(input.code, "authorization_code_invalid", 2048);
  const nonce = requireToken(input.nonce, "nonce_invalid");
  const verifier = requireString(input.verifier, "code_verifier_invalid", 128);
  if (!SAFE_CODE_VERIFIER.test(verifier)) invalid("code_verifier_invalid");
  const fetcher = input.fetcher ?? fetch.bind(globalThis);
  const idToken = await exchangeCode({ clientId: config.clientId, clientSecret: config.clientSecret, code, redirectUri: config.redirectUri, verifier, fetcher });
  return verifyGoogleIdToken({ clientId: config.clientId, fetcher, idToken, nonce, now: input.now ?? new Date() });
}

export async function resolveGoogleIdentity(input: GoogleBindings & { allowCreate?: boolean; claims: GoogleClaims; now?: Date; initiatedUserId?: string | null; retryingEmailRace?: boolean }): Promise<GoogleIdentityResult> {
  const email = normalizeGoogleEmail(input.claims.email);
  const displayName = userDisplayName(input.claims);
  const subject = await subjectHash(input, input.claims.sub);
  const now = timestamp(input.now);
  const existing = await input.PLATFORM_DB.prepare(`
    SELECT auth_google_identities.id, auth_google_identities.user_id AS userId,
      platform_users.status
    FROM auth_google_identities
    INNER JOIN platform_users ON platform_users.id = auth_google_identities.user_id
    WHERE auth_google_identities.subject_hash = ? LIMIT 1
  `).bind(subject).first<{ id: string; status: "active" | "pending" | "suspended"; userId: string }>();
  if (existing !== null) {
    if (existing.status === "suspended") throw new AppError("authentication_required", 401);
    if (input.initiatedUserId !== undefined && input.initiatedUserId !== null && existing.userId !== input.initiatedUserId) throw new AppError("google_identity_in_use", 409);
    const refreshIdentity = () => refreshGoogleIdentity({ ...input, identityId: existing.id, now });
    if (input.allowCreate === true) {
      // Self-heal a partial/legacy registration: the Google identity is
      // authoritative, so a pending user must not remain locked out after a
      // retry observes the already-persisted identity.
      await refreshIdentity();
      const activation = await input.PLATFORM_DB.prepare(`
        UPDATE platform_users
        SET status = 'active', email_verified_at = COALESCE(email_verified_at, ?),
          is_verified = 1, verified_at = COALESCE(verified_at, ?), updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, now, now, existing.userId).run();
      if (activation.meta.changes !== 1) {
        const user = await input.PLATFORM_DB.prepare(`SELECT status FROM platform_users WHERE id = ? LIMIT 1`).bind(existing.userId).first<{ status: string }>();
        if (user?.status !== "active") throw new AppError("authentication_required", 401);
      }
    } else {
      await refreshIdentity();
    }
    return { created: false, displayName, email, identityId: existing.id, userId: existing.userId };
  }
  if (input.initiatedUserId !== undefined && input.initiatedUserId !== null) {
    const user = await input.PLATFORM_DB.prepare(`SELECT id, email_normalized AS email FROM platform_users WHERE id = ? AND status = 'active' LIMIT 1`).bind(input.initiatedUserId).first<{ email: string; id: string }>();
    if (user === null) throw new AppError("authentication_required", 401);
    const linked = await input.PLATFORM_DB.prepare(`SELECT id FROM auth_google_identities WHERE user_id = ? LIMIT 1`).bind(user.id).first<{ id: string }>();
    if (linked !== null) throw new AppError("google_already_linked", 409);
    const identityId = createId("gid");
    try {
      await input.PLATFORM_DB.prepare(`INSERT INTO auth_google_identities (id, user_id, subject_hash, subject_key_version, created_at, last_authenticated_at, updated_at, version) VALUES (?, ?, ?, 'v1', ?, ?, ?, 1)`).bind(identityId, user.id, subject, now, now, now).run();
    } catch {
      const [subjectOwner, userIdentity] = await Promise.all([
        input.PLATFORM_DB.prepare(`SELECT user_id AS userId FROM auth_google_identities WHERE subject_hash = ? LIMIT 1`).bind(subject).first<{ userId: string }>(),
        input.PLATFORM_DB.prepare(`SELECT id FROM auth_google_identities WHERE user_id = ? LIMIT 1`).bind(user.id).first<{ id: string }>(),
      ]);
      if (subjectOwner !== null && subjectOwner.userId !== user.id) throw new AppError("google_identity_in_use", 409);
      if (userIdentity !== null || subjectOwner?.userId === user.id) throw new AppError("google_already_linked", 409);
      throw new AppError("google_link_conflict", 409);
    }
    return { created: false, displayName, email, identityId, userId: user.id };
  }
  const existingEmail = await input.PLATFORM_DB.prepare(`
    SELECT id, status FROM platform_users WHERE email_normalized = ? LIMIT 1
  `).bind(email).first<{ id: string; status: "active" | "pending" | "suspended" }>();
  if (existingEmail !== null) {
    if (existingEmail.status === "suspended") throw new AppError("authentication_required", 401);
    if (input.allowCreate !== true) throw new AppError("google_account_link_required", 409);

    // A verified Google email is an explicit proof of ownership for the same
    // email account. Attach it atomically so Google login works for accounts
    // that were originally created with a password or magic link.
    const identityId = createId("gid");
    let attachResults: Array<{ meta: { changes: number } }>;
    try {
      attachResults = await input.PLATFORM_DB.batch([
        input.PLATFORM_DB.prepare(`
          UPDATE platform_users
          SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            email_verified_at = COALESCE(email_verified_at, ?), is_verified = 1,
            verified_at = COALESCE(verified_at, ?), updated_at = ?
          WHERE id = ? AND status != 'suspended'
        `).bind(now, now, now, existingEmail.id),
        input.PLATFORM_DB.prepare(`
          INSERT INTO auth_google_identities (
            id, user_id, subject_hash, subject_key_version, created_at,
            last_authenticated_at, updated_at, version
          )
          SELECT ?, ?, ?, 'v1', ?, ?, ?, 1
          FROM platform_users
          WHERE id = ? AND status != 'suspended'
        `).bind(identityId, existingEmail.id, subject, now, now, now, existingEmail.id),
      ]);
    } catch {
      const [subjectOwner, userIdentity] = await Promise.all([
        input.PLATFORM_DB.prepare(`SELECT id, user_id AS userId FROM auth_google_identities WHERE subject_hash = ? LIMIT 1`).bind(subject).first<{ id: string; userId: string }>(),
        input.PLATFORM_DB.prepare(`SELECT id FROM auth_google_identities WHERE user_id = ? LIMIT 1`).bind(existingEmail.id).first<{ id: string }>(),
      ]);
      if (subjectOwner?.userId === existingEmail.id) {
        return { created: false, displayName, email, identityId: subjectOwner.id, userId: existingEmail.id };
      }
      if (subjectOwner !== null) throw new AppError("google_identity_in_use", 409);
      if (userIdentity !== null) throw new AppError("google_already_linked", 409);
      throw new AppError("google_link_conflict", 409);
    }
    if (attachResults[0]?.meta.changes !== 1 || attachResults[1]?.meta.changes !== 1) {
      throw new AppError("authentication_required", 401);
    }
    return { created: false, displayName, email, identityId, userId: existingEmail.id };
  }
  if (input.allowCreate !== true) throw new AppError("google_account_not_found", 404);
  const userId = createId("usr");
  const identityId = createId("gid");
  try {
    await input.PLATFORM_DB.batch([
      input.PLATFORM_DB.prepare(`INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at, is_verified, verified_at, email_verified_at) VALUES (?, ?, ?, 'active', ?, ?, 1, ?, ?)`).bind(userId, email, displayName, now, now, now, now),
      input.PLATFORM_DB.prepare(`INSERT INTO auth_google_identities (id, user_id, subject_hash, subject_key_version, created_at, last_authenticated_at, updated_at, version) VALUES (?, ?, ?, 'v1', ?, ?, ?, 1)`).bind(identityId, userId, subject, now, now, now),
    ]);
  } catch {
    const raced = await input.PLATFORM_DB.prepare(`SELECT id, user_id AS userId FROM auth_google_identities WHERE subject_hash = ? LIMIT 1`).bind(subject).first<{ id: string; userId: string }>();
    if (raced !== null) return { created: false, displayName, email, identityId: raced.id, userId: raced.userId };
    // A password/magic-link registration may have claimed this email between
    // the lookup above and the batch insert. Re-enter the existing-email path
    // so the same Google callback can attach instead of forcing a restart.
    const racedEmail = await input.PLATFORM_DB.prepare(`SELECT id FROM platform_users WHERE email_normalized = ? LIMIT 1`).bind(email).first<{ id: string }>();
    if (racedEmail !== null && input.retryingEmailRace !== true) {
      return resolveGoogleIdentity({ ...input, retryingEmailRace: true });
    }
    throw new AppError("google_registration_conflict", 409);
  }
  return { created: true, displayName, email, identityId, userId };
}

export function resetGoogleJwksCache(): void {
  cachedJwks = null;
}

export function googleAuthorizationError(value: unknown): string {
  if (value === "access_denied") return "access_denied";
  return "provider_error";
}

export function googleStateCookieName(env: Pick<AppBindings, "SESSION_COOKIE_NAME">): string {
  return `${env.SESSION_COOKIE_NAME}_google_state`;
}

export function googleTwoFactorCookieName(env: Pick<AppBindings, "SESSION_COOKIE_NAME">): string {
  return `${env.SESSION_COOKIE_NAME}_google_2fa`;
}
