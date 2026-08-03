import { AppError } from "../core/errors";
import { constantTimeEqual } from "../core/crypto";
import { createOpaqueToken, toBase64Url } from "../core/ids";

const AUTHORIZATION_ENDPOINT = "https://oauth.zaloapp.com/v4/oa/permission";
const TOKEN_ENDPOINT = "https://oauth.zaloapp.com/v4/oa/access_token";
const SAFE_APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
// Zalo's OA v4 guide specifies a 43-character verifier. Keep the local
// contract narrower than the generic PKCE upper bound until provider docs
// explicitly admit other lengths.
const SAFE_PKCE_VALUE = /^[A-Za-z0-9._~-]{43}$/u;
const SAFE_STATE = /^[A-Za-z0-9_-]{43,128}$/u;
const encoder = new TextEncoder();

export type ZaloOfficialAccountOAuthRequest = {
  appId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  authorizationUrl: string;
};

export type ZaloOfficialAccountTokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
};

function invalid(issue: string): never {
  throw new AppError("zalo_oa_oauth_invalid", 400, [issue]);
}

function providerFailure(issue: string, status = 502): never {
  throw new AppError("zalo_oa_oauth_exchange_failed", status, [issue]);
}

function requireAppId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_APP_ID.test(value)) invalid("app_id_invalid");
  return value;
}

function requireState(value: unknown): string {
  if (typeof value !== "string" || !SAFE_STATE.test(value)) invalid("state_invalid");
  return value;
}

function requireCodeVerifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_PKCE_VALUE.test(value)) invalid("code_verifier_invalid");
  return value;
}

function requireSecretKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512 || hasControlCharacter(value)) {
    invalid("secret_key_invalid");
  }
  return value;
}

function requireAuthorizationCode(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || hasControlCharacter(value)) {
    invalid("authorization_code_invalid");
  }
  return value;
}

function requireRedirectUri(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) invalid("redirect_uri_invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("redirect_uri_invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    invalid("redirect_uri_invalid");
  }
  // Preserve the registered value byte-for-byte; OAuth redirect matching is exact.
  return value;
}

function parseProviderJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) providerFailure("response_invalid");
  return value as Record<string, unknown>;
}

function requireToken(value: unknown, issue: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || hasControlCharacter(value)) {
    providerFailure(issue);
  }
  return value;
}

function requireExpiry(value: unknown): number {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^\d{1,9}$/u.test(raw)) providerFailure("expires_in_invalid");
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 31_536_000) providerFailure("expires_in_invalid");
  return seconds;
}

/**
 * Zalo's current OA page is inconsistent: examples use `expires_in`, while
 * the response-property table spells the same field `expire_in`. Accept both
 * only when one is present (or when both agree) so a provider typo cannot
 * silently produce an unbounded credential lifetime.
 */
function requireProviderExpiry(payload: Record<string, unknown>): number {
  const expiresIn = payload.expires_in;
  const expireIn = payload.expire_in;
  if (typeof expiresIn === "undefined" && typeof expireIn === "undefined") {
    providerFailure("expires_in_invalid");
  }
  const parsedExpiresIn = typeof expiresIn === "undefined" ? null : requireExpiry(expiresIn);
  const parsedExpireIn = typeof expireIn === "undefined" ? null : requireExpiry(expireIn);
  if (parsedExpiresIn !== null && parsedExpireIn !== null && parsedExpiresIn !== parsedExpireIn) {
    providerFailure("expires_in_conflict");
  }
  return parsedExpiresIn ?? parsedExpireIn as number;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * Creates the provider authorization request. The verifier is returned only
 * for the caller's transient state store; it must never be sent to a browser
 * or persisted in plaintext.
 */
export async function createZaloOfficialAccountOAuthRequest(input: {
  appId: string;
  redirectUri: string;
  state?: string;
}): Promise<ZaloOfficialAccountOAuthRequest> {
  const appId = requireAppId(input.appId);
  const redirectUri = requireRedirectUri(input.redirectUri);
  const state = input.state === undefined ? createOpaqueToken(32) : requireState(input.state);
  const codeVerifier = createOpaqueToken(32);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
  const codeChallenge = toBase64Url(new Uint8Array(digest));
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return Object.freeze({ appId, redirectUri, state, codeVerifier, codeChallenge, authorizationUrl: url.toString() });
}

export function verifyZaloOfficialAccountOAuthState(input: { expectedState: string; receivedState: string }): void {
  const expectedState = requireState(input.expectedState);
  const receivedState = requireState(input.receivedState);
  if (!constantTimeEqual(expectedState, receivedState)) invalid("state_mismatch");
}

/**
 * Exchanges a one-use Zalo OA authorization code. This helper deliberately
 * does not write D1: the caller must bind the verified state to its tenant,
 * encrypt the returned tokens and activate a reviewed connection separately.
 */
export async function exchangeZaloOfficialAccountAuthorizationCode(input: {
  appId: string;
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
  secretKey: string;
  fetcher?: typeof fetch;
}): Promise<ZaloOfficialAccountTokenResponse> {
  const appId = requireAppId(input.appId);
  const authorizationCode = requireAuthorizationCode(input.authorizationCode);
  const codeVerifier = requireCodeVerifier(input.codeVerifier);
  requireRedirectUri(input.redirectUri);
  const secretKey = requireSecretKey(input.secretKey);
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", secret_key: secretKey },
      body: new URLSearchParams({
        app_id: appId,
        code: authorizationCode,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }).toString(),
    });
  } catch {
    providerFailure("network_error");
  }
  if (!response.ok) providerFailure("provider_rejected", 502);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    providerFailure("response_invalid");
  }
  const payload = parseProviderJson(body);
  if (typeof payload.error !== "undefined") providerFailure("provider_rejected", 502);
  const expiresInSeconds = requireProviderExpiry(payload);
  const accessToken = requireToken(payload.access_token, "access_token_invalid");
  const refreshToken = requireToken(payload.refresh_token, "refresh_token_invalid");
  return Object.freeze({ accessToken, refreshToken, expiresInSeconds });
}

/**
 * Exchanges a rotating, one-use OA refresh token. The caller must atomically
 * replace the encrypted token envelope only after this response is durable.
 */
export async function refreshZaloOfficialAccountToken(input: {
  appId: string;
  refreshToken: string;
  secretKey: string;
  fetcher?: typeof fetch;
}): Promise<ZaloOfficialAccountTokenResponse> {
  const appId = requireAppId(input.appId);
  const refreshToken = requireToken(input.refreshToken, "refresh_token_invalid");
  const secretKey = requireSecretKey(input.secretKey);
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", secret_key: secretKey },
      body: new URLSearchParams({ app_id: appId, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
  } catch {
    providerFailure("network_error");
  }
  if (!response.ok) providerFailure("provider_rejected", 502);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    providerFailure("response_invalid");
  }
  const payload = parseProviderJson(body);
  if (typeof payload.error !== "undefined") providerFailure("provider_rejected", 502);
  return Object.freeze({
    accessToken: requireToken(payload.access_token, "access_token_invalid"),
    refreshToken: requireToken(payload.refresh_token, "refresh_token_invalid"),
    expiresInSeconds: requireProviderExpiry(payload),
  });
}

export const ZALO_OFFICIAL_ACCOUNT_OAUTH_AUTHORIZATION_ENDPOINT = AUTHORIZATION_ENDPOINT;
export const ZALO_OFFICIAL_ACCOUNT_OAUTH_TOKEN_ENDPOINT = TOKEN_ENDPOINT;
