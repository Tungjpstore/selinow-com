import { hmacToken } from "../core/crypto";
import { subscriptionAllows } from "../billing/entitlements";
import { AppError } from "../core/errors";
import { createId, toBase64Url } from "../core/ids";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import { createZaloOfficialAccountOAuthRequest } from "./zalo-oa-oauth";
import { hashZaloOfficialAccountOAuthState, verifyZaloOfficialAccountOAuthStateHash } from "./zalo-oa-state";

const PROVIDER_CODE = "zalo.oa" as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_KEY_VERSION = /^v[1-9][0-9]{0,3}$/u;
const SAFE_STATE = /^[A-Za-z0-9_-]{43,128}$/u;
const DEFAULT_STATE_LIFETIME_MS = 10 * 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type StateBindings = Pick<
  AppBindings,
  | "ACTIVE_CREDENTIAL_KEY_VERSION"
  | "CREDENTIAL_KEK_V1"
  | "CREDENTIAL_KEK_V2"
  | "CREDENTIAL_KEY_VERSION"
  | "PLATFORM_DB"
  | "SESSION_SECRET"
>;

type OAuthStateRow = {
  appId: string;
  codeVerifierCiphertextB64: string;
  codeVerifierIvB64: string;
  connectorRequestId: string;
  createdAt: string;
  expiresAt: string;
  keyVersion: string;
  redirectUri: string;
  requestId: string;
  shopId: string;
  stateHash: string;
  stateLookupHash: string | null;
  status: "consumed" | "pending" | "revoked";
  version: number;
};

export type ZaloOfficialAccountOAuthState = {
  appId: string;
  authorizationUrl: string;
  connectorRequestId: string;
  expiresAt: string;
  providerCode: typeof PROVIDER_CODE;
  requestId: string;
  shopId: string;
  state: string;
  status: "pending";
};

export type ConsumedZaloOfficialAccountOAuthState = {
  appId: string;
  codeVerifier: string;
  connectorRequestId: string;
  expiresAt: string;
  providerCode: typeof PROVIDER_CODE;
  redirectUri: string;
  requestId: string;
  shopId: string;
};

function invalid(issue: string): never {
  throw new AppError("zalo_oa_oauth_invalid", 400, [issue]);
}

function stateNotFound(): never {
  throw new AppError("zalo_oa_oauth_state_not_found", 404);
}

function stateReplay(): never {
  throw new AppError("zalo_oa_oauth_state_replay", 409);
}

function requireIdentifier(value: unknown, issue: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) invalid(issue);
  return value;
}

function requireState(value: unknown): string {
  if (typeof value !== "string" || !SAFE_STATE.test(value)) invalid("state_invalid");
  return value;
}

function requireKeyVersion(value: unknown): string {
  if (typeof value !== "string" || !SAFE_KEY_VERSION.test(value)) invalid("key_version_invalid");
  return value;
}

function timestamp(value: Date | string | undefined, issue: string): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) invalid(issue);
  return date.toISOString();
}

function expiry(value: Date | string | undefined, now: string): string {
  const expiresAt = value === undefined
    ? new Date(Date.parse(now) + DEFAULT_STATE_LIFETIME_MS).toISOString()
    : timestamp(value, "expires_at_invalid");
  const nowMs = Date.parse(now);
  const expiryMs = Date.parse(expiresAt);
  if (expiryMs <= nowMs || expiryMs > nowMs + 15 * 60_000) invalid("expires_at_invalid");
  return expiresAt;
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

async function aesKey(kek: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const bytes = decodeBase64Url(kek, "key_invalid");
  if (bytes.byteLength !== 32) invalid("key_invalid");
  try {
    return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usage);
  } catch {
    invalid("key_invalid");
  }
}

function stateAad(input: { connectorRequestId: string; keyVersion: string; requestId: string; shopId: string }): Uint8Array<ArrayBuffer> {
  return encoder.encode(`provider-oauth-state\0${PROVIDER_CODE}\0${input.keyVersion}\0${input.shopId}\0${input.connectorRequestId}\0${input.requestId}\0envelope`);
}

async function stateLookupHash(sessionSecret: string, state: string): Promise<string> {
  return hmacToken(sessionSecret, "zalo-oa-oauth-lookup:v1", state);
}

async function encryptCodeVerifier(input: { codeVerifier: string; connectorRequestId: string; keyVersion: string; kek: string; requestId: string; shopId: string }): Promise<{ ciphertextB64: string; ivB64: string }> {
  const key = await aesKey(input.kek, ["decrypt", "encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: stateAad(input), iv, name: "AES-GCM", tagLength: 128 },
    key,
    encoder.encode(input.codeVerifier),
  );
  return { ciphertextB64: toBase64Url(new Uint8Array(ciphertext)), ivB64: toBase64Url(iv) };
}

async function decryptCodeVerifier(input: { ciphertextB64: string; connectorRequestId: string; ivB64: string; keyVersion: string; kek: string; requestId: string; shopId: string }): Promise<string> {
  const ciphertext = decodeBase64Url(input.ciphertextB64, "ciphertext_invalid");
  const iv = decodeBase64Url(input.ivB64, "iv_invalid");
  if (ciphertext.byteLength < 16 || iv.byteLength !== 12) invalid("envelope_invalid");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { additionalData: stateAad(input), iv, name: "AES-GCM", tagLength: 128 },
      await aesKey(input.kek, ["decrypt"]),
      ciphertext,
    );
    const codeVerifier = decoder.decode(plaintext);
    if (!/^[A-Za-z0-9._~-]{43}$/u.test(codeVerifier)) invalid("code_verifier_invalid");
    return codeVerifier;
  } catch (error) {
    if (error instanceof AppError && error.code === "zalo_oa_oauth_invalid") throw error;
    throw new AppError("zalo_oa_oauth_state_decryption_failed", 500);
  }
}

async function assertShopScope(database: D1Database, shopId: string): Promise<void> {
  const row = await database.prepare(`
    SELECT shops.id,
      shop_subscriptions.state AS subscriptionState,
      shop_subscriptions.trial_ends_at AS trialEndsAt,
      shop_subscriptions.grace_ends_at AS graceEndsAt
    FROM shops
    INNER JOIN shop_subscriptions
      ON shop_subscriptions.shop_id = shops.id
    WHERE shops.id = ? AND shops.status = 'active'
    LIMIT 1
  `).bind(shopId).first<{ graceEndsAt: string | null; id: string; subscriptionState: string; trialEndsAt: string | null }>();
  if (row === null || !subscriptionAllows({ graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })) {
    throw new AppError("zalo_oa_oauth_state_scope_invalid", 409);
  }
}

async function assertConnectorScope(database: D1Database, shopId: string, connectorRequestId: string): Promise<void> {
  const row = await database.prepare(`
    SELECT id
    FROM channel_connector_requests
    WHERE id = ? AND shop_id = ?
      AND channel_code = ? AND provider_code = ?
      AND status IN ('requested', 'provider_pending', 'active')
    LIMIT 1
  `).bind(connectorRequestId, shopId, PROVIDER_CODE, PROVIDER_CODE).first<{ id: string }>();
  if (row === null) throw new AppError("zalo_oa_oauth_connector_scope_invalid", 409);
}

async function loadState(database: D1Database, input: { requestId: string; shopId: string }): Promise<OAuthStateRow | null> {
  return database.prepare(`
    SELECT app_id AS appId,
      code_verifier_ciphertext_b64 AS codeVerifierCiphertextB64,
      code_verifier_iv_b64 AS codeVerifierIvB64,
      connector_request_id AS connectorRequestId,
      created_at AS createdAt, expires_at AS expiresAt,
      key_version AS keyVersion, redirect_uri AS redirectUri,
      request_id AS requestId, shop_id AS shopId, state_hash AS stateHash,
      state_lookup_hash AS stateLookupHash,
      status, version
    FROM channel_oauth_states
    WHERE shop_id = ? AND request_id = ? AND provider_code = ?
    LIMIT 1
  `).bind(input.shopId, input.requestId, PROVIDER_CODE).first<OAuthStateRow>();
}

async function loadStateByRequestId(database: D1Database, requestId: string): Promise<OAuthStateRow | null> {
  return database.prepare(`
    SELECT app_id AS appId,
      code_verifier_ciphertext_b64 AS codeVerifierCiphertextB64,
      code_verifier_iv_b64 AS codeVerifierIvB64,
      connector_request_id AS connectorRequestId,
      created_at AS createdAt, expires_at AS expiresAt,
      key_version AS keyVersion, redirect_uri AS redirectUri,
      request_id AS requestId, shop_id AS shopId, state_hash AS stateHash,
      state_lookup_hash AS stateLookupHash,
      status, version
    FROM channel_oauth_states
    WHERE request_id = ? AND provider_code = ?
    LIMIT 1
  `).bind(requestId, PROVIDER_CODE).first<OAuthStateRow>();
}

async function loadStateByLookupHash(database: D1Database, lookupHash: string): Promise<OAuthStateRow | null> {
  return database.prepare(`
    SELECT app_id AS appId,
      code_verifier_ciphertext_b64 AS codeVerifierCiphertextB64,
      code_verifier_iv_b64 AS codeVerifierIvB64,
      connector_request_id AS connectorRequestId,
      created_at AS createdAt, expires_at AS expiresAt,
      key_version AS keyVersion, redirect_uri AS redirectUri,
      request_id AS requestId, shop_id AS shopId, state_hash AS stateHash,
      state_lookup_hash AS stateLookupHash,
      status, version
    FROM channel_oauth_states
    WHERE state_lookup_hash = ? AND provider_code = ?
    LIMIT 1
  `).bind(lookupHash, PROVIDER_CODE).first<OAuthStateRow>();
}

/** Issues a short-lived OAuth state and stores only a hash plus encrypted verifier. */
export async function issueZaloOfficialAccountOAuthState(input: StateBindings & {
  appId: string;
  connectorRequestId: string;
  expiresAt?: Date | string;
  now?: Date | string;
  redirectUri: string;
  requestId?: string;
  state?: string;
  shopId: string;
}): Promise<ZaloOfficialAccountOAuthState> {
  const shopId = requireIdentifier(input.shopId, "shop_id_invalid");
  const connectorRequestId = requireIdentifier(input.connectorRequestId, "connector_request_id_invalid");
  const now = timestamp(input.now, "request_time_invalid");
  const expiresAt = expiry(input.expiresAt, now);
  await assertShopScope(input.PLATFORM_DB, shopId);
  await assertConnectorScope(input.PLATFORM_DB, shopId, connectorRequestId);
  if (typeof input.SESSION_SECRET !== "string" || input.SESSION_SECRET.length < 16) invalid("state_secret_invalid");
  const oauth = await createZaloOfficialAccountOAuthRequest({ appId: input.appId, redirectUri: input.redirectUri, ...(input.state === undefined ? {} : { state: input.state }) });
  const requestId = input.requestId === undefined
    ? createId("zoa")
    : requireIdentifier(input.requestId, "request_id_invalid");
  const stateHash = await hashZaloOfficialAccountOAuthState({ connectorRequestId, sessionSecret: input.SESSION_SECRET, shopId, state: oauth.state });
  const lookupHash = await stateLookupHash(input.SESSION_SECRET, oauth.state);
  const activeKey = resolveActiveEncryptionKey(input, "credential");
  const encrypted = await encryptCodeVerifier({ codeVerifier: oauth.codeVerifier, connectorRequestId, keyVersion: activeKey.version, kek: activeKey.kek, requestId, shopId });
  try {
    await input.PLATFORM_DB.prepare(`
      INSERT INTO channel_oauth_states (
        id, shop_id, connector_request_id, request_id, provider_code, app_id, redirect_uri,
        state_hash, state_lookup_hash, code_verifier_ciphertext_b64, code_verifier_iv_b64,
        key_version, status, expires_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1)
    `).bind(
      requestId, shopId, connectorRequestId, requestId, PROVIDER_CODE, oauth.appId, oauth.redirectUri,
      stateHash, lookupHash, encrypted.ciphertextB64, encrypted.ivB64, activeKey.version,
      expiresAt, now, now,
    ).run();
  } catch {
    throw new AppError("zalo_oa_oauth_state_conflict", 409);
  }
  return Object.freeze({
    appId: oauth.appId,
    authorizationUrl: oauth.authorizationUrl,
    connectorRequestId,
    expiresAt,
    providerCode: PROVIDER_CODE,
    requestId,
    shopId,
    state: oauth.state,
    status: "pending",
  });
}

/** Atomically consumes one pending state and returns the verifier in memory. */
export async function consumeZaloOfficialAccountOAuthState(input: StateBindings & {
  now?: Date | string;
  receivedState: string;
  requestId: string;
  shopId: string;
}): Promise<ConsumedZaloOfficialAccountOAuthState> {
  const shopId = requireIdentifier(input.shopId, "shop_id_invalid");
  const requestId = requireIdentifier(input.requestId, "request_id_invalid");
  const now = timestamp(input.now, "request_time_invalid");
  const row = await loadState(input.PLATFORM_DB, { requestId, shopId });
  if (row === null) stateNotFound();
  if (row.status !== "pending") stateReplay();
  if (Date.parse(row.expiresAt) <= Date.parse(now)) throw new AppError("zalo_oa_oauth_state_expired", 409);
  if (typeof input.SESSION_SECRET !== "string" || input.SESSION_SECRET.length < 16) invalid("state_secret_invalid");
  await verifyZaloOfficialAccountOAuthStateHash({
    connectorRequestId: row.connectorRequestId,
    expectedHash: row.stateHash,
    receivedState: input.receivedState,
    sessionSecret: input.SESSION_SECRET,
    shopId,
  });
  const key = resolveEncryptionKey(input, "credential", requireKeyVersion(row.keyVersion));
  const codeVerifier = await decryptCodeVerifier({
    ciphertextB64: row.codeVerifierCiphertextB64,
    connectorRequestId: row.connectorRequestId,
    ivB64: row.codeVerifierIvB64,
    keyVersion: key.version,
    kek: key.kek,
    requestId,
    shopId,
  });
  const consumedAt = now;
  const mutation = await input.PLATFORM_DB.prepare(`
    UPDATE channel_oauth_states
    SET status = 'consumed', consumed_at = ?, updated_at = ?, version = version + 1
    WHERE shop_id = ? AND request_id = ? AND provider_code = ?
      AND status = 'pending' AND expires_at > ? AND version = ? AND state_hash = ?
  `).bind(consumedAt, consumedAt, shopId, requestId, PROVIDER_CODE, now, row.version, row.stateHash).run();
  if (mutation.meta.changes !== 1) stateReplay();
  return Object.freeze({
    appId: row.appId,
    codeVerifier,
    connectorRequestId: row.connectorRequestId,
    expiresAt: row.expiresAt,
    providerCode: PROVIDER_CODE,
    redirectUri: row.redirectUri,
    requestId,
    shopId,
  });
}

/** Consumes a callback state after resolving its tenant from the opaque request ID. */
export async function consumeZaloOfficialAccountOAuthStateByRequestId(input: StateBindings & {
  now?: Date | string;
  receivedState: string;
  requestId: string;
}): Promise<ConsumedZaloOfficialAccountOAuthState> {
  const requestId = requireIdentifier(input.requestId, "request_id_invalid");
  const row = await loadStateByRequestId(input.PLATFORM_DB, requestId);
  if (row === null) stateNotFound();
  return consumeZaloOfficialAccountOAuthState({
    ...input,
    requestId,
    shopId: row.shopId,
  });
}

/**
 * Resolves a public callback state through a blind lookup hash, then delegates
 * to the tenant-bound verifier and CAS consumer. The browser never supplies
 * the tenant or connector identifiers.
 */
export async function consumeZaloOfficialAccountOAuthStateByState(input: StateBindings & {
  now?: Date | string;
  receivedState: string;
}): Promise<ConsumedZaloOfficialAccountOAuthState> {
  const receivedState = requireState(input.receivedState);
  if (typeof input.SESSION_SECRET !== "string" || input.SESSION_SECRET.length < 16) invalid("state_secret_invalid");
  const lookupHash = await stateLookupHash(input.SESSION_SECRET, receivedState);
  const row = await loadStateByLookupHash(input.PLATFORM_DB, lookupHash);
  if (row === null) stateNotFound();
  return consumeZaloOfficialAccountOAuthState({
    ...input,
    receivedState,
    requestId: row.requestId,
    shopId: row.shopId,
  });
}
