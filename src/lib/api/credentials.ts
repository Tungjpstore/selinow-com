import { AppError } from "../core/errors";
import { assertQuotaAvailable, recordUsage } from "../billing/metering";
import { subscriptionAllows } from "../billing/entitlements";
import { parsePlanFeatures, parsePlanLimits, PUBLIC_PLAN_CODES } from "../billing/plan-catalog";
import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

const API_SCOPES = ["catalog:read", "inventory:read", "orders:read", "shop:read"] as const;
const API_SCOPE_SET = new Set<string>(API_SCOPES);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const SAFE_REASON_CODE = /^[a-z][a-z0-9._:-]{2,95}$/u;
const TOKEN_PATTERN = /^sln_(local|staging|production)_(akc_[0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u;
const MAX_CREDENTIAL_LIFETIME_MS = 366 * 24 * 60 * 60_000;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export type ApiCredentialScope = typeof API_SCOPES[number];
export type ApiCredentialStatus = "active" | "revoked";

type ApiCredentialRow = {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  lastUsedAt: string | null;
  name: string;
  publicId: string;
  revokedAt: string | null;
  revokeReason: string | null;
  scopeJson: string;
  status: ApiCredentialStatus;
  version: number;
};

type ExistingIssuance = {
  request_hash: string;
  response_json: string;
};

type ApiCredentialReplayReference = {
  credentialPublicId: string;
  shopId: string;
};

export type ApiCredentialView = {
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  name: string;
  publicId: string;
  revokedAt: string | null;
  scopes: ApiCredentialScope[];
  status: ApiCredentialStatus;
  version: number;
};

export type ApiCredentialIssueResult = {
  credential: ApiCredentialView;
  replayed: boolean;
  token: string | null;
  tokenAvailable: boolean;
};

export type ApiRateLimit = {
  limit: number;
  remaining: number;
  resetAt: string;
};

export type PublicApiContext = {
  credentialPublicId: string;
  rateLimit: ApiRateLimit;
  shop: {
    currency: string;
    defaultLocale: string;
    name: string;
    publicId: string;
    status: string;
    timezone: string;
  };
  shopId: string;
};

function validationError(issue: string): AppError {
  return new AppError("validation_failed", 400, [issue]);
}

function parseScopeJson(value: string): ApiCredentialScope[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0
      || parsed.some((scope) => typeof scope !== "string" || !API_SCOPE_SET.has(scope))) {
      throw new Error("api_credential_scope_invalid");
    }
    return [...new Set(parsed as ApiCredentialScope[])].sort();
  } catch {
    throw new AppError("api_credential_scope_invalid", 500);
  }
}

function mapCredential(row: ApiCredentialRow): ApiCredentialView {
  return {
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    name: row.name,
    publicId: row.publicId,
    revokedAt: row.revokedAt,
    scopes: parseScopeJson(row.scopeJson),
    status: row.status,
    version: row.version,
  };
}

function parseReplayReference(value: string): ApiCredentialReplayReference {
  try {
    const parsed = JSON.parse(value) as Partial<ApiCredentialReplayReference>;
    if (typeof parsed.credentialPublicId !== "string" || typeof parsed.shopId !== "string") {
      throw new Error("api_credential_replay_invalid");
    }
    return { credentialPublicId: parsed.credentialPublicId, shopId: parsed.shopId };
  } catch {
    throw new AppError("api_credential_replay_invalid", 500);
  }
}

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !IDEMPOTENCY_KEY.test(value)) {
    throw validationError("idempotency_key_invalid");
  }
  return value;
}

function requireCredentialName(value: unknown): string {
  if (typeof value !== "string") throw validationError("name_required");
  const name = value.trim().replace(/\s+/gu, " ");
  if (name.length < 1 || name.length > 80) throw validationError("name_invalid");
  return name;
}

export function parseApiCredentialScopes(value: unknown): ApiCredentialScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > API_SCOPES.length) {
    throw validationError("scopes_invalid");
  }
  if (value.some((scope) => typeof scope !== "string" || !API_SCOPE_SET.has(scope))) {
    throw validationError("scopes_invalid");
  }
  const scopes = [...new Set(value as ApiCredentialScope[])].sort();
  if (scopes.length !== value.length) throw validationError("scopes_duplicate");
  return scopes;
}

function parseExpiry(value: unknown, now: Date): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw validationError("expires_at_invalid");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value
    || timestamp <= now.getTime() || timestamp > now.getTime() + MAX_CREDENTIAL_LIFETIME_MS) {
    throw validationError("expires_at_invalid");
  }
  return value;
}

export function parseApiCredentialCreateInput(
  value: Record<string, unknown>,
  now = new Date(),
): { expiresAt: string | null; name: string; scopes: ApiCredentialScope[] } {
  return {
    expiresAt: parseExpiry(value.expiresAt, now),
    name: requireCredentialName(value.name),
    scopes: parseApiCredentialScopes(value.scopes),
  };
}

export function parseApiCredentialRevokeInput(
  value: Record<string, unknown>,
): { expectedVersion: number; reasonCode: string } {
  if (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 1) {
    throw validationError("expected_version_invalid");
  }
  if (typeof value.reasonCode !== "string" || !SAFE_REASON_CODE.test(value.reasonCode)) {
    throw validationError("reason_code_invalid");
  }
  return { expectedVersion: value.expectedVersion as number, reasonCode: value.reasonCode };
}

async function loadCredential(
  env: AppBindings,
  shopId: string,
  publicId: string,
): Promise<ApiCredentialRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id, public_id AS publicId, name, scope_json AS scopeJson, status,
      expires_at AS expiresAt, last_used_at AS lastUsedAt,
      revoked_at AS revokedAt, revoke_reason AS revokeReason,
      version, created_at AS createdAt
    FROM api_credentials
    WHERE shop_id = ? AND public_id = ?
    LIMIT 1
  `).bind(shopId, publicId).first<ApiCredentialRow>();
}

async function resolveReplay(input: {
  existing: ExistingIssuance;
  expectedRequestHash: string;
  env: AppBindings;
  shopId: string;
}): Promise<ApiCredentialIssueResult> {
  if (input.existing.request_hash !== input.expectedRequestHash) {
    throw new AppError("idempotency_conflict", 409);
  }
  const reference = parseReplayReference(input.existing.response_json);
  if (reference.shopId !== input.shopId) throw new AppError("idempotency_conflict", 409);
  const credential = await loadCredential(input.env, input.shopId, reference.credentialPublicId);
  if (credential === null) throw new AppError("api_credential_replay_invalid", 500);
  return { credential: mapCredential(credential), replayed: true, token: null, tokenAvailable: false };
}

function issuanceError(error: unknown): AppError | null {
  if (!(error instanceof Error)) return null;
  if (error.message.includes("api_credential_active_limit_reached")) {
    return new AppError("api_credential_limit_reached", 409);
  }
  return null;
}

export async function issueApiCredential(input: {
  env: AppBindings;
  expiresAt: string | null;
  idempotencyKey: string | null;
  name: string;
  now?: Date;
  requestId: string;
  scopes: ApiCredentialScope[];
  shopPublicId: string;
  userId: string;
}): Promise<ApiCredentialIssueResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const actor = await getShopForMember({
    capability: "team:manage",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  if (actor.row.shop_status === "suspended" || actor.row.shop_status === "archived") {
    throw new AppError("tenant_suspended", 403);
  }
  const name = requireCredentialName(input.name);
  const scopes = parseApiCredentialScopes(input.scopes);
  const expiresAt = parseExpiry(input.expiresAt, now);
  const namespace = `api-credential.create.v1:${actor.row.shop_id}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "api-credential-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ expiresAt, name, scopes, shopId: actor.row.shop_id });
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, now.toISOString()).first<ExistingIssuance>();
  if (existing !== null) {
    return resolveReplay({
      env: input.env,
      existing,
      expectedRequestHash: requestHash,
      shopId: actor.row.shop_id,
    });
  }

  // A reused key after the short idempotency retention window must be allowed
  // to create a new credential rather than replaying stale metadata.
  await input.env.PLATFORM_DB.prepare(`
    DELETE FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND expires_at <= ?
  `).bind(input.userId, namespace, keyHash, now.toISOString()).run();

  const id = createId("ack");
  const publicId = createId("akc");
  const token = `sln_${input.env.APP_ENV}_${publicId}.${createOpaqueToken()}`;
  const tokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "api-credential-token:v1", token);
  const nowIso = now.toISOString();
  const idempotencyExpiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  const replayReference = JSON.stringify({ credentialPublicId: publicId, shopId: actor.row.shop_id });
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO api_credentials (
          id, public_id, shop_id, name, scope_json, token_hash, status,
          expires_at, created_by_user_id, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)
      `).bind(
        id,
        publicId,
        actor.row.shop_id,
        name,
        JSON.stringify(scopes),
        tokenHash,
        expiresAt,
        input.userId,
        nowIso,
        nowIso,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        ) VALUES (?, ?, 'user', ?, 'api_credential.issued', 'api_credential', ?, ?, ?, 'http', 'security', ?)
      `).bind(
        createId("aud"),
        actor.row.shop_id,
        input.userId,
        id,
        JSON.stringify({ credentialPublicId: publicId, expiresAt, scopes }),
        input.requestId,
        nowIso,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash,
          response_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.userId,
        namespace,
        keyHash,
        requestHash,
        replayReference,
        nowIso,
        idempotencyExpiresAt,
      ),
    ]);
  } catch (error) {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
        AND expires_at > ?
      LIMIT 1
    `).bind(input.userId, namespace, keyHash, nowIso).first<ExistingIssuance>();
    if (replay !== null) {
      return resolveReplay({
        env: input.env,
        existing: replay,
        expectedRequestHash: requestHash,
        shopId: actor.row.shop_id,
      });
    }
    throw issuanceError(error) ?? error;
  }
  const credential = await loadCredential(input.env, actor.row.shop_id, publicId);
  if (credential === null) throw new AppError("api_credential_issue_failed", 500);
  return { credential: mapCredential(credential), replayed: false, token, tokenAvailable: true };
}

export async function listApiCredentials(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<ApiCredentialView[]> {
  const actor = await getShopForMember({
    capability: "team:manage",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, public_id AS publicId, name, scope_json AS scopeJson, status,
      expires_at AS expiresAt, last_used_at AS lastUsedAt,
      revoked_at AS revokedAt, revoke_reason AS revokeReason,
      version, created_at AS createdAt
    FROM api_credentials
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).bind(actor.row.shop_id).all<ApiCredentialRow>();
  return rows.results.map(mapCredential);
}

export async function revokeApiCredential(input: {
  credentialPublicId: string;
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  reasonCode: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<ApiCredentialView> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError("expected_version_invalid");
  }
  if (!SAFE_REASON_CODE.test(input.reasonCode)) throw validationError("reason_code_invalid");
  const actor = await getShopForMember({
    capability: "team:manage",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `api-credential.revoke.v1:${actor.row.shop_id}:${input.credentialPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "api-credential-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({
    expectedVersion: input.expectedVersion,
    reasonCode: input.reasonCode,
    shopId: actor.row.shop_id,
  });
  const resolveIdempotentRevoke = async (existing: ExistingIssuance): Promise<ApiCredentialView> => {
    if (existing.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const reference = parseReplayReference(existing.response_json);
    if (reference.shopId !== actor.row.shop_id || reference.credentialPublicId !== input.credentialPublicId) {
      throw new AppError("api_credential_replay_invalid", 500);
    }
    const replay = await loadCredential(input.env, actor.row.shop_id, input.credentialPublicId);
    if (replay === null || replay.status !== "revoked") {
      throw new AppError("api_credential_replay_invalid", 500);
    }
    return mapCredential(replay);
  };
  const existingIdempotency = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<ExistingIssuance>();
  if (existingIdempotency !== null) return resolveIdempotentRevoke(existingIdempotency);
  await input.env.PLATFORM_DB.prepare(`
    DELETE FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND expires_at <= ?
  `).bind(input.userId, namespace, keyHash, nowIso).run();

  const replayReference = JSON.stringify({
    credentialPublicId: input.credentialPublicId,
    shopId: actor.row.shop_id,
  });
  const idempotencyExpiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  const auditId = createId("aud");
  let results: D1Result[];
  try {
    results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE api_credentials
        SET status = 'revoked', revoked_at = ?, revocation_request_hash = ?, revoke_reason = ?,
          version = version + 1, updated_at = ?
        WHERE shop_id = ? AND public_id = ? AND status = 'active' AND version = ?
      `).bind(
        nowIso,
        keyHash,
        input.reasonCode,
        nowIso,
        actor.row.shop_id,
        input.credentialPublicId,
        input.expectedVersion,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        )
        SELECT ?, ?, 'user', ?, 'api_credential.revoked', 'api_credential', id,
          ?, ?, 'http', 'security', ?
        FROM api_credentials
        WHERE shop_id = ? AND public_id = ? AND status = 'revoked'
          AND revocation_request_hash = ? AND version = ? AND changes() = 1
      `).bind(
        auditId,
        actor.row.shop_id,
        input.userId,
        JSON.stringify({ credentialPublicId: input.credentialPublicId, reasonCode: input.reasonCode }),
        input.requestId,
        nowIso,
        actor.row.shop_id,
        input.credentialPublicId,
        keyHash,
        input.expectedVersion + 1,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash,
          response_json, created_at, expires_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM audit_logs
          WHERE id = ? AND shop_id = ? AND actor_id = ?
            AND action = 'api_credential.revoked'
        )
      `).bind(
        input.userId,
        namespace,
        keyHash,
        requestHash,
        replayReference,
        nowIso,
        idempotencyExpiresAt,
        auditId,
        actor.row.shop_id,
        input.userId,
      ),
    ]);
  } catch (error) {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
        AND expires_at > ?
      LIMIT 1
    `).bind(input.userId, namespace, keyHash, nowIso).first<ExistingIssuance>();
    if (replay !== null) return resolveIdempotentRevoke(replay);
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) !== 1
    || (results[1]?.meta.changes ?? 0) !== 1
    || (results[2]?.meta.changes ?? 0) !== 1) {
    const existing = await loadCredential(input.env, actor.row.shop_id, input.credentialPublicId);
    if (existing === null) throw new AppError("api_credential_not_found", 404);
    if (existing.status === "revoked"
      && existing.version === input.expectedVersion + 1
      && existing.revokeReason === input.reasonCode) {
      return mapCredential(existing);
    }
    throw new AppError("api_credential_version_conflict", 409);
  }
  const credential = await loadCredential(input.env, actor.row.shop_id, input.credentialPublicId);
  if (credential === null) throw new AppError("api_credential_not_found", 404);
  return mapCredential(credential);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || authorization.includes(",") || !authorization.startsWith("Bearer ")) {
    throw new AppError("authentication_required", 401);
  }
  const token = authorization.slice("Bearer ".length);
  if (token.length < 80 || token.length > 180 || token.trim() !== token) {
    throw new AppError("authentication_required", 401);
  }
  return token;
}

async function claimRateLimit(input: {
  credentialId: string;
  env: AppBindings;
  now: Date;
  shopId: string;
  subjectHash: string;
}): Promise<ApiRateLimit> {
  const windowStartedAtMs = Math.floor(input.now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const windowStartedAt = new Date(windowStartedAtMs).toISOString();
  const resetAt = new Date(windowStartedAtMs + RATE_WINDOW_MS).toISOString();
  const row = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO security_rate_limits (
      id, shop_id, scope_key, action, subject_hash,
      window_started_at, window_ends_at, request_count, blocked_count,
      blocked_until, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'public_api_v1', ?, ?, ?, 1, 0, NULL, 1, ?, ?)
    ON CONFLICT(scope_key, action, subject_hash, window_started_at)
    DO UPDATE SET
      request_count = security_rate_limits.request_count + 1,
      blocked_count = security_rate_limits.blocked_count + CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN 1 ELSE 0 END,
      blocked_until = CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN excluded.window_ends_at
        ELSE security_rate_limits.blocked_until END,
      version = security_rate_limits.version + 1,
      updated_at = excluded.updated_at
    RETURNING request_count AS requestCount
  `).bind(
    createId("lim"),
    input.shopId,
    `api-credential:${input.credentialId}`,
    input.subjectHash,
    windowStartedAt,
    resetAt,
    input.now.toISOString(),
    input.now.toISOString(),
    RATE_LIMIT,
    RATE_LIMIT,
  ).first<{ requestCount: number }>();
  if (row === null) throw new AppError("api_rate_limit_record_failed", 500);
  const requestCount = row.requestCount;
  if (requestCount > RATE_LIMIT) throw new AppError("rate_limited", 429);
  return { limit: RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - requestCount), resetAt };
}

export async function authenticatePublicApiRequest(input: {
  env: AppBindings;
  now?: Date;
  request: Request;
  requiredScope: ApiCredentialScope;
}): Promise<PublicApiContext> {
  const token = bearerToken(input.request);
  const match = TOKEN_PATTERN.exec(token);
  if (match === null || match[1] !== input.env.APP_ENV) {
    throw new AppError("authentication_required", 401);
  }
  const publicId = match[2];
  if (publicId === undefined) throw new AppError("authentication_required", 401);
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT api_credentials.id, api_credentials.public_id AS credentialPublicId,
      api_credentials.shop_id AS shopId, api_credentials.token_hash AS tokenHash,
      api_credentials.scope_json AS scopeJson, api_credentials.status,
      api_credentials.expires_at AS expiresAt, api_credentials.version,
      shops.public_id AS shopPublicId, shops.name AS shopName,
      shops.status AS shopStatus, shops.default_locale AS defaultLocale,
      shops.currency, shops.timezone,
      shop_subscriptions.state AS subscriptionState,
      shop_subscriptions.current_period_end AS currentPeriodEnd,
      shop_subscriptions.trial_ends_at AS trialEndsAt,
      shop_subscriptions.grace_ends_at AS graceEndsAt,
      plans.code AS planCode,
      plans.feature_flags_json AS featureFlagsJson,
      plans.limits_json AS limitsJson
    FROM api_credentials
    INNER JOIN shops ON shops.id = api_credentials.shop_id
    INNER JOIN shop_subscriptions
      ON shop_subscriptions.shop_id = shops.id
      AND shop_subscriptions.state != 'canceled'
    INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
    WHERE api_credentials.public_id = ?
    LIMIT 1
  `).bind(publicId).first<{
    credentialPublicId: string;
    currency: string;
    defaultLocale: string;
    expiresAt: string | null;
    id: string;
    scopeJson: string;
    shopId: string;
    shopName: string;
    shopPublicId: string;
    shopStatus: string;
    status: ApiCredentialStatus;
    subscriptionState: string;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    graceEndsAt: string | null;
    planCode: string;
    featureFlagsJson: string;
    limitsJson: string;
    timezone: string;
    tokenHash: string;
    version: number;
  }>();
  if (row === null || row.status !== "active") throw new AppError("authentication_required", 401);
  const tokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "api-credential-token:v1", token);
  if (!constantTimeEqual(row.tokenHash, tokenHash)) throw new AppError("authentication_required", 401);
  const now = input.now ?? new Date();
  if (row.expiresAt !== null && row.expiresAt <= now.toISOString()) {
    throw new AppError("authentication_required", 401);
  }
  if (row.shopStatus === "suspended" || row.shopStatus === "archived") {
    throw new AppError("tenant_suspended", 403);
  }
  if (!subscriptionAllows({ currentPeriodEnd: row.currentPeriodEnd, graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })) {
    throw new AppError("subscription_required", 402);
  }
  const scopes = parseScopeJson(row.scopeJson);
  if (!scopes.includes(input.requiredScope)) throw new AppError("authorization_denied", 403);
  // Starter deliberately has no public API allowance. Legacy plans retain
  // their historical behavior until their subscriptions are migrated.
  if ((PUBLIC_PLAN_CODES as readonly string[]).includes(row.planCode)) {
    const features = parsePlanFeatures(row.featureFlagsJson);
    if (!features.ok || !features.value.api) throw new AppError("plan_feature_unavailable", 402, ["api"]);
    const limits = parsePlanLimits(row.limitsJson);
    if (!limits.ok) throw new AppError("quota_unavailable", 503, ["api_requests"]);
    await assertQuotaAvailable({
      database: input.env.PLATFORM_DB,
      limit: limits.value.api_requests,
      metric: "api_requests",
      shopId: row.shopId,
    });
  }
  const rateLimit = await claimRateLimit({
    credentialId: row.id,
    env: input.env,
    now,
    shopId: row.shopId,
    subjectHash: row.tokenHash,
  });
  const used = await input.env.PLATFORM_DB.prepare(`
    UPDATE api_credentials
    SET last_used_at = ?, updated_at = ?
    WHERE shop_id = ? AND id = ? AND status = 'active'
      AND (expires_at IS NULL OR expires_at > ?)
  `).bind(
    now.toISOString(),
    now.toISOString(),
    row.shopId,
    row.id,
    now.toISOString(),
  ).run();
  if (used.meta.changes !== 1) throw new AppError("authentication_required", 401);
  return {
    credentialPublicId: row.credentialPublicId,
    rateLimit,
    shop: {
      currency: row.currency,
      defaultLocale: row.defaultLocale,
      name: row.shopName,
      publicId: row.shopPublicId,
      status: row.shopStatus,
      timezone: row.timezone,
    },
    shopId: row.shopId,
  };
}

/** Record one successfully served public API request after its read succeeds. */
export async function recordPublicApiUsage(input: {
  context: PublicApiContext;
  env: AppBindings;
  requestId: string;
  now?: Date;
}): Promise<void> {
  const plan = await input.env.PLATFORM_DB.prepare(`
    SELECT plans.code, plans.limits_json AS limitsJson
    FROM shop_subscriptions AS subscriptions
    INNER JOIN plans ON plans.id = subscriptions.plan_id
    WHERE subscriptions.shop_id = ? AND subscriptions.state != 'canceled'
    ORDER BY subscriptions.created_at DESC, subscriptions.id DESC
    LIMIT 1
  `).bind(input.context.shopId).first<{ code: string; limitsJson: string }>();
  if (plan === null || !(PUBLIC_PLAN_CODES as readonly string[]).includes(plan.code)) return;
  const limits = parsePlanLimits(plan.limitsJson);
  if (!limits.ok) throw new AppError("quota_unavailable", 503, ["api_requests"]);
  await recordUsage({
    database: input.env.PLATFORM_DB,
    delta: 1,
    limit: limits.value.api_requests,
    metric: "api_requests",
    occurredAt: (input.now ?? new Date()).toISOString(),
    shopId: input.context.shopId,
    sourceId: input.requestId,
    sourceKind: "api_request",
  });
}
