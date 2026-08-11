import { AppError } from "../core/errors";
import { constantTimeEqual, hmacToken } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import { getPlanLimit, hasFeature } from "../tenants/policy";
import {
  CloudflareProviderError,
  CloudflareSaaSClient,
  type CloudflareCustomHostname,
  type CloudflareTurnstileHostnameAdmission,
} from "./cloudflare";
import { verifyCustomDomainOwnership, verifyCustomHostnameDns, type DnsVerificationResult } from "./dns";
import { isCloudflareHostnameReady, normalizeCustomHostname } from "./policy";
import { customDomainTurnstileAdmissionSql, hasFreshExactTurnstileAdmission } from "./readiness";

const DOMAIN_SELECT = `
  SELECT
    id,
    shop_id AS shopId,
    hostname_normalized AS hostname,
    type,
    status,
    is_primary AS isPrimary,
    cloudflare_hostname_id AS cloudflareHostnameId,
    hostname_status AS hostnameStatus,
    ssl_status AS sslStatus,
    dns_status AS dnsStatus,
    validation_metadata_json AS validationMetadataJson,
    last_checked_at AS lastCheckedAt,
    activated_at AS activatedAt,
    next_check_at AS nextCheckAt,
    check_attempts AS checkAttempts,
    lease_token AS leaseToken,
    lease_expires_at AS leaseExpiresAt,
    last_safe_error_code AS lastSafeErrorCode,
    deleted_at AS deletedAt,
    delete_requested_at AS deleteRequestedAt,
    ownership_verified_at AS ownershipVerifiedAt,
    version,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM shop_domains
`;

const DOMAIN_CLAIM_SELECT = `
  SELECT
    id,
    shop_id AS shopId,
    hostname_normalized AS hostname,
    challenge_hash AS challengeHash,
    expires_at AS expiresAt,
    verified_at AS verifiedAt,
    last_checked_at AS lastCheckedAt,
    check_attempts AS checkAttempts,
    last_safe_error_code AS lastSafeErrorCode,
    version,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM custom_domain_claims
`;

const TERMINAL_HOSTNAME_STATUSES = new Set(["blocked", "deleted", "moved", "pending_blocked", "test_blocked", "test_failed"]);
const TERMINAL_SSL_STATUSES = new Set([
  "deleted",
  "deletion_timed_out",
  "deployment_timed_out",
  "expired",
  "inactive",
  "initializing_timed_out",
  "issuance_timed_out",
  "validation_timed_out",
]);

type DomainBindings = AppBindings & {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
  SAAS_CNAME_TARGET: string;
  TURNSTILE_SITE_KEY: string;
};

type DomainRow = {
  activatedAt: string | null;
  checkAttempts: number;
  cloudflareHostnameId: string | null;
  createdAt: string;
  deleteRequestedAt: string | null;
  deletedAt: string | null;
  dnsStatus: string | null;
  hostname: string;
  hostnameStatus: string | null;
  id: string;
  isPrimary: number;
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  nextCheckAt: string | null;
  ownershipVerifiedAt: string | null;
  shopId: string;
  sslStatus: string | null;
  status: string;
  type: "custom" | "platform_subdomain";
  updatedAt: string;
  validationMetadataJson: string;
  version: number;
};

type DomainClaimRow = {
  challengeHash: string;
  checkAttempts: number;
  createdAt: string;
  expiresAt: string;
  hostname: string;
  id: string;
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  shopId: string;
  updatedAt: string;
  verifiedAt: string | null;
  version: number;
};

type ProviderCheckResult = {
  outcome: "checked" | "failed";
  row: DomainRow;
};

type DomainActor = {
  customDomainLimit: number | null;
  shopId: string;
};

const DOMAIN_LEASE_MS = 90_000;
const DOMAIN_CLAIM_TTL_MS = 30 * 60_000;

export type DomainView = {
  activatedAt: string | null;
  createdAt: string;
  dnsInstructions: { name: string; target: string; type: "CNAME" | "TXT" } | null;
  dnsStatus: string | null;
  hostname: string;
  hostnameStatus: string | null;
  id: string;
  isPrimary: boolean;
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  ownershipStatus: "pending" | "verified" | null;
  sslStatus: string | null;
  status: string;
  turnstileStatus: "active" | "error" | "pending" | null;
  type: "custom" | "platform_subdomain";
  updatedAt: string;
  validation: Record<string, unknown>;
  version: number;
};

export type DomainProvider = Pick<
  CloudflareSaaSClient,
  "createCustomHostname" | "deleteCustomHostname" | "findCustomHostname" | "getCustomHostname" | "verifyTurnstileHostnameAdmission"
>;

export type DomainRuntime = {
  dnsVerifier?: (input: { expectedTarget: string; hostname: string }) => Promise<DnsVerificationResult>;
  fetcher?: typeof fetch;
  now?: Date;
  ownershipVerifier?: (input: { challengeName: string; expectedValue: string }) => Promise<{ observedValues: string[]; status: "active" | "error" | "pending" }>;
  provider?: DomainProvider;
};

function bindingString(env: AppBindings, key: keyof DomainBindings): string {
  const value = (env as DomainBindings)[key];
  if (typeof value !== "string" || value.length === 0) throw new AppError("cloudflare_config_invalid", 500);
  return value;
}

function createProvider(env: AppBindings, runtime: DomainRuntime): DomainProvider {
  return runtime.provider ?? new CloudflareSaaSClient(
    bindingString(env, "CLOUDFLARE_API_TOKEN"),
    bindingString(env, "CLOUDFLARE_ZONE_ID"),
    runtime.fetcher,
  );
}

function getSaasTarget(env: AppBindings): string {
  const value = (env as Partial<DomainBindings>).SAAS_CNAME_TARGET;
  if ((typeof value !== "string" || value.length === 0) && env.APP_ENV === "local") {
    return `customers.${env.PLATFORM_BASE_DOMAIN}`.toLowerCase().replace(/\.$/u, "");
  }
  if (typeof value !== "string" || value.length === 0) throw new AppError("cloudflare_config_invalid", 500);
  const target = value.trim().toLowerCase().replace(/\.$/u, "");
  // Production and staging must use the reviewed Cloudflare for SaaS target.
  if (env.APP_ENV !== "local" && target !== "customers.selinow.com") {
    throw new AppError("cloudflare_config_invalid", 500);
  }
  return target;
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function turnstileAdmissionStatus(metadata: Record<string, unknown>, hostname: string, now = new Date()): DomainView["turnstileStatus"] {
  const value = metadata.turnstile;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const admission = value as Record<string, unknown>;
  if (
    admission.hostname !== hostname
    || admission.mode !== "operator_managed"
    || admission.source !== "cloudflare_widget_domains"
    || !["active", "error", "pending"].includes(String(admission.status))
  ) return null;
  if (admission.status === "active" && !hasFreshExactTurnstileAdmission({ hostname, now, validationMetadataJson: metadata })) {
    return "pending";
  }
  return admission.status as DomainView["turnstileStatus"];
}

function mapDomain(row: DomainRow, saasTarget: string): DomainView {
  const validation = safeJsonObject(row.validationMetadataJson);
  return {
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
    dnsInstructions: row.type === "custom" && row.deletedAt === null
      ? row.ownershipVerifiedAt === null
        ? { name: `_selinow-verify.${row.hostname}`, target: "ownership proof required", type: "TXT" }
        : { name: row.hostname, target: saasTarget, type: "CNAME" }
      : null,
    dnsStatus: row.dnsStatus,
    hostname: row.hostname,
    hostnameStatus: row.hostnameStatus,
    id: row.id,
    isPrimary: row.isPrimary === 1,
    lastCheckedAt: row.lastCheckedAt,
    lastSafeErrorCode: row.lastSafeErrorCode,
    ownershipStatus: row.type === "custom" ? (row.ownershipVerifiedAt === null ? "pending" : "verified") : null,
    sslStatus: row.sslStatus,
    status: row.status,
    turnstileStatus: row.type === "custom" ? turnstileAdmissionStatus(validation, row.hostname) : null,
    type: row.type,
    updatedAt: row.updatedAt,
    validation,
    version: row.version,
  };
}

function claimChallengeName(hostname: string): string {
  return `_selinow-verify.${hostname}`;
}

async function claimChallengeValue(env: AppBindings, row: Pick<DomainClaimRow, "expiresAt" | "hostname" | "id" | "shopId">): Promise<string> {
  const token = await hmacToken(env.SESSION_SECRET, "custom-domain-ownership", `${row.id}\0${row.shopId}\0${row.hostname}\0${row.expiresAt}`);
  return `selinow-verification=${token}`;
}

async function claimChallengeHash(env: AppBindings, value: string): Promise<string> {
  return hmacToken(env.SESSION_SECRET, "custom-domain-ownership-hash", value);
}

async function mapClaim(env: AppBindings, row: DomainClaimRow, now = new Date()): Promise<DomainView> {
  const expired = row.expiresAt <= now.toISOString();
  const challenge = await claimChallengeValue(env, row);
  return {
    activatedAt: row.verifiedAt,
    createdAt: row.createdAt,
    dnsInstructions: expired ? null : { name: claimChallengeName(row.hostname), target: challenge, type: "TXT" },
    dnsStatus: expired ? "error" : "pending",
    hostname: row.hostname,
    hostnameStatus: null,
    id: row.id,
    isPrimary: false,
    lastCheckedAt: row.lastCheckedAt,
    lastSafeErrorCode: row.lastSafeErrorCode,
    ownershipStatus: row.verifiedAt === null ? "pending" : "verified",
    sslStatus: null,
    status: row.verifiedAt !== null ? "active" : expired ? "ownership_expired" : "ownership_pending",
    turnstileStatus: null,
    type: "custom",
    updatedAt: row.updatedAt,
    validation: { expiresAt: row.expiresAt, ownershipChallenge: true },
    version: row.version,
  };
}

function platformHostnames(env: AppBindings): string[] {
  const values = [
    env.PLATFORM_BASE_DOMAIN,
    getSaasTarget(env),
    new URL(env.PLATFORM_ORIGIN).hostname,
    new URL(env.DASHBOARD_ORIGIN).hostname,
    new URL(env.API_ORIGIN).hostname,
  ];
  return Array.from(new Set(values.filter((value) => value.includes("."))));
}

async function requireDomainActor(
  env: AppBindings,
  shopPublicId: string,
  userId: string,
  access: "read" | "manage",
  requireEntitlement: boolean,
): Promise<DomainActor> {
  const member = await getShopForMember({ capability: access === "manage" ? "domains:manage" : "domains:read", env, shopPublicId, userId });
  if (requireEntitlement && !hasFeature(member.row.feature_flags_json, "customDomain")) {
    throw new AppError("subscription_required", 402, ["custom_domain_not_in_plan"]);
  }
  const customDomainLimit = requireEntitlement
    ? getPlanLimit(member.row.limits_json, "customDomains")
    : null;
  if (requireEntitlement && customDomainLimit === null) {
    throw new AppError("subscription_configuration_invalid", 500, ["custom_domain_limit_invalid"]);
  }
  return { customDomainLimit, shopId: member.row.shop_id };
}

async function findDomainById(env: AppBindings, shopId: string, domainId: string): Promise<DomainRow | null> {
  return env.PLATFORM_DB.prepare(`${DOMAIN_SELECT} WHERE id = ? AND shop_id = ? LIMIT 1`)
    .bind(domainId, shopId)
    .first<DomainRow>();
}

async function findDomainByHostname(env: AppBindings, hostname: string): Promise<DomainRow | null> {
  return env.PLATFORM_DB.prepare(`${DOMAIN_SELECT}
    WHERE hostname_normalized = ? AND deleted_at IS NULL
      AND (type = 'platform_subdomain' OR ownership_verified_at IS NOT NULL)
    LIMIT 1
  `)
    .bind(hostname)
    .first<DomainRow>();
}

async function findClaimById(env: AppBindings, shopId: string, claimId: string): Promise<DomainClaimRow | null> {
  return env.PLATFORM_DB.prepare(`${DOMAIN_CLAIM_SELECT} WHERE id = ? AND shop_id = ? LIMIT 1`)
    .bind(claimId, shopId)
    .first<DomainClaimRow>();
}

async function findClaimByHostname(env: AppBindings, shopId: string, hostname: string): Promise<DomainClaimRow | null> {
  return env.PLATFORM_DB.prepare(`${DOMAIN_CLAIM_SELECT} WHERE shop_id = ? AND hostname_normalized = ? LIMIT 1`)
    .bind(shopId, hostname)
    .first<DomainClaimRow>();
}

function requireDomain(row: DomainRow | null): DomainRow {
  if (row === null || row.deletedAt !== null) throw new AppError("domain_not_found", 404);
  return row;
}

function validationMetadata(
  provider: CloudflareCustomHostname,
  dns: DnsVerificationResult,
  turnstile: CloudflareTurnstileHostnameAdmission,
  checkedAt: string,
): string {
  return JSON.stringify({
    dns: { observedTargets: dns.observedTargets },
    ownershipVerification: provider.ownership_verification ?? null,
    ownershipVerificationHttp: provider.ownership_verification_http ?? null,
    sslDcvDelegationRecords: provider.ssl.dcv_delegation_records ?? [],
    sslValidationRecords: provider.ssl.validation_records ?? [],
    turnstile: { ...turnstile, checkedAt },
  });
}

export function customDomainState(input: { dnsStatus: string; hostnameStatus: string; sslStatus: string; turnstileStatus: string }): "active" | "failed" | "validating" {
  if (isCloudflareHostnameReady(input) && input.turnstileStatus === "active") return "active";
  if (TERMINAL_HOSTNAME_STATUSES.has(input.hostnameStatus) || TERMINAL_SSL_STATUSES.has(input.sslStatus)) return "failed";
  return "validating";
}

export function customDomainBackoffSeconds(attempts: number, status: string): number {
  if (status === "active") return 6 * 60 * 60;
  if (status === "failed") return 24 * 60 * 60;
  return Math.min(60 * 60, 30 * 2 ** Math.min(Math.max(attempts, 0), 7));
}

function nextCheckAt(now: Date, attempts: number, status: string): string {
  return new Date(now.getTime() + customDomainBackoffSeconds(attempts, status) * 1_000).toISOString();
}

async function recoverOrCreateProviderHostname(client: DomainProvider, row: DomainRow): Promise<CloudflareCustomHostname> {
  if (row.cloudflareHostnameId !== null) {
    try {
      const current = await client.getCustomHostname(row.cloudflareHostnameId);
      if (current.hostname.toLowerCase() !== row.hostname) throw new AppError("domain_provider_conflict", 409);
      return current;
    } catch (error) {
      if (!(error instanceof CloudflareProviderError) || error.code !== "cloudflare_hostname_not_found") throw error;
    }
  }

  const recovered = await client.findCustomHostname(row.hostname);
  if (recovered !== null) return recovered;
  try {
    return await client.createCustomHostname(row.hostname);
  } catch (error) {
    try {
      const afterError = await client.findCustomHostname(row.hostname);
      if (afterError !== null) return afterError;
    } catch {
      // Preserve the original provider error when recovery is also unavailable.
    }
    throw error;
  }
}

function safeProviderError(error: unknown): string {
  return error instanceof AppError ? error.code : "provider_unavailable";
}

function isPermanentProviderError(error: unknown): boolean {
  return error instanceof AppError && (error.code === "domain_provider_conflict" || (error instanceof CloudflareProviderError && error.status === 409));
}

type CheckPersistenceGuard = {
  canonicalDomainId: string | null;
  fallbackDomainId: string | null;
  needsFailover: boolean;
  row: DomainRow;
};

async function persistCheckTransition(input: {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  prepareTarget: (guard: CheckPersistenceGuard) => D1PreparedStatement;
  reasonCode: string | null;
  row: DomainRow;
  status: "active" | "failed" | "validating";
}): Promise<DomainRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = requireDomain(await findDomainById(input.env, input.row.shopId, input.row.id));
    if (row.leaseToken !== input.leaseToken || row.deleteRequestedAt !== null) throw new AppError("domain_lease_lost", 409);
    const shop = await input.env.PLATFORM_DB.prepare(`
      SELECT canonical_domain_id AS canonicalDomainId FROM shops WHERE id = ? LIMIT 1
    `).bind(row.shopId).first<{ canonicalDomainId: string | null }>();
    const canonicalDomainId = shop?.canonicalDomainId ?? null;
    const needsFailover = input.status !== "active" && (row.isPrimary === 1 || canonicalDomainId === row.id);
    const fallback = needsFailover
      ? await input.env.PLATFORM_DB.prepare(`
          SELECT id FROM shop_domains
          WHERE shop_id = ? AND type = 'platform_subdomain' AND status = 'active'
            AND delete_requested_at IS NULL AND deleted_at IS NULL
          ORDER BY created_at, id LIMIT 1
        `).bind(row.shopId).first<{ id: string }>()
      : null;
    const statements: D1PreparedStatement[] = [input.prepareTarget({
      canonicalDomainId,
      fallbackDomainId: fallback?.id ?? null,
      needsFailover,
      row,
    })];

    if (needsFailover) {
      const markerVersion = row.version + 1;
      statements.push(input.env.PLATFORM_DB.prepare(`
        /* domain:check-demote-routing */
        UPDATE shop_domains
        SET is_primary = 0, version = version + 1, updated_at = ?
        WHERE shop_id = ? AND id <> ? AND is_primary = 1 AND deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM shop_domains target
            WHERE target.id = ? AND target.shop_id = ? AND target.status = ?
              AND target.is_primary = 0 AND target.delete_requested_at IS NULL
              AND target.deleted_at IS NULL AND target.lease_token IS NULL AND target.version = ?
          )
      `).bind(input.now.toISOString(), row.shopId, row.id, row.id, row.shopId, input.status, markerVersion));
      if (fallback !== null) {
        statements.push(input.env.PLATFORM_DB.prepare(`
          /* domain:check-promote-fallback */
          UPDATE shop_domains
          SET is_primary = 1, version = version + 1, updated_at = ?
          WHERE id = ? AND shop_id = ? AND type = 'platform_subdomain' AND status = 'active'
            AND delete_requested_at IS NULL AND deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM shop_domains target
              WHERE target.id = ? AND target.shop_id = ? AND target.status = ?
                AND target.is_primary = 0 AND target.delete_requested_at IS NULL
                AND target.deleted_at IS NULL AND target.lease_token IS NULL AND target.version = ?
            )
        `).bind(input.now.toISOString(), fallback.id, row.shopId, row.id, row.shopId, input.status, markerVersion));
      }
      statements.push(input.env.PLATFORM_DB.prepare(`
        /* domain:check-set-fallback-canonical */
        UPDATE shops SET canonical_domain_id = ?, readiness_version = readiness_version + 1, updated_at = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM shop_domains target
          WHERE target.id = ? AND target.shop_id = shops.id AND target.status = ?
            AND target.is_primary = 0 AND target.delete_requested_at IS NULL
            AND target.deleted_at IS NULL AND target.lease_token IS NULL AND target.version = ?
        )${fallback === null ? "" : ` AND EXISTS (
          SELECT 1 FROM shop_domains fallback
          WHERE fallback.id = ? AND fallback.shop_id = shops.id AND fallback.is_primary = 1
            AND fallback.type = 'platform_subdomain' AND fallback.status = 'active'
            AND fallback.delete_requested_at IS NULL AND fallback.deleted_at IS NULL
        )`}
      `).bind(
        fallback?.id ?? null,
        input.now.toISOString(),
        row.shopId,
        row.id,
        input.status,
        markerVersion,
        ...(fallback === null ? [] : [fallback.id]),
      ));
      statements.push(input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, created_at
        ) SELECT ?, ?, 'system', NULL, 'domain.primary_failed_over', 'shop_domain', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM shop_domains target
          WHERE target.id = ? AND target.shop_id = ? AND target.status = ?
            AND target.is_primary = 0 AND target.delete_requested_at IS NULL
            AND target.deleted_at IS NULL AND target.lease_token IS NULL AND target.version = ?
        )
      `).bind(
        createId("aud"),
        row.shopId,
        row.id,
        JSON.stringify({ fromDomainId: row.id, reasonCode: input.reasonCode, toDomainId: fallback?.id ?? null }),
        `domain-reconcile:${row.id}:${input.now.toISOString()}`,
        input.now.toISOString(),
        row.id,
        row.shopId,
        input.status,
        markerVersion,
      ));
    }

    const results = await input.env.PLATFORM_DB.batch(statements);
    if (results[0]?.meta.changes !== 1) continue;
    if (needsFailover) {
      const canonicalResultIndex = fallback === null ? 2 : 3;
      if ((fallback !== null && results[2]?.meta.changes !== 1) || results[canonicalResultIndex]?.meta.changes !== 1) {
        throw new AppError("domain_routing_conflict", 409);
      }
    }
    return requireDomain(await findDomainById(input.env, row.shopId, row.id));
  }
  throw new AppError("domain_lease_lost", 409);
}

async function persistCheckFailure(input: {
  env: AppBindings;
  error: unknown;
  leaseToken: string;
  now: Date;
  row: DomainRow;
}): Promise<DomainRow> {
  const attempts = input.row.checkAttempts + 1;
  const status = isPermanentProviderError(input.error) ? "failed" : "validating";
  const retryAfter = input.error instanceof CloudflareProviderError ? input.error.retryAfter : null;
  const delay = Math.max(customDomainBackoffSeconds(attempts, status), retryAfter ?? 0);
  const errorCode = safeProviderError(input.error);
  return persistCheckTransition({
    env: input.env,
    leaseToken: input.leaseToken,
    now: input.now,
    prepareTarget: ({ canonicalDomainId, fallbackDomainId, needsFailover, row }) => input.env.PLATFORM_DB.prepare(`
      /* domain:persist-check-failure */
      UPDATE shop_domains
      SET status = ?, is_primary = 0, check_attempts = ?, next_check_at = ?, last_checked_at = ?,
          last_safe_error_code = ?, lease_token = NULL, lease_expires_at = NULL,
          version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND deleted_at IS NULL
        AND delete_requested_at IS NULL AND lease_token = ? AND version = ? AND is_primary = ?
        AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND canonical_domain_id IS ?)
        ${needsFailover && fallbackDomainId !== null ? `AND EXISTS (
          SELECT 1 FROM shop_domains fallback
          WHERE fallback.id = ? AND fallback.shop_id = ? AND fallback.type = 'platform_subdomain'
            AND fallback.status = 'active' AND fallback.delete_requested_at IS NULL AND fallback.deleted_at IS NULL
        )` : ""}
    `).bind(
      status,
      attempts,
      new Date(input.now.getTime() + delay * 1_000).toISOString(),
      input.now.toISOString(),
      errorCode,
      input.now.toISOString(),
      row.id,
      row.shopId,
      input.leaseToken,
      row.version,
      row.isPrimary,
      row.shopId,
      canonicalDomainId,
      ...(needsFailover && fallbackDomainId !== null ? [fallbackDomainId, row.shopId] : []),
    ),
    reasonCode: errorCode,
    row: input.row,
    status,
  });
}

async function persistProviderCheck(input: {
  dns: DnsVerificationResult;
  env: AppBindings;
  leaseToken: string;
  now: Date;
  provider: CloudflareCustomHostname;
  row: DomainRow;
  turnstile: CloudflareTurnstileHostnameAdmission;
}): Promise<DomainRow> {
  if (input.provider.hostname.toLowerCase() !== input.row.hostname) throw new AppError("domain_provider_conflict", 409);
  const status = customDomainState({
    dnsStatus: input.dns.status,
    hostnameStatus: input.provider.status,
    sslStatus: input.provider.ssl.status,
    turnstileStatus: input.turnstile.status,
  });
  const attempts = input.row.checkAttempts + 1;
  const errorCode = input.dns.status === "error"
    ? "domain_dns_lookup_failed"
    : input.dns.status === "pending"
      ? "domain_dns_pending"
      : input.turnstile.status === "pending"
        ? "domain_turnstile_admission_pending"
        : null;
  return persistCheckTransition({
    env: input.env,
    leaseToken: input.leaseToken,
    now: input.now,
    prepareTarget: ({ canonicalDomainId, fallbackDomainId, needsFailover, row }) => input.env.PLATFORM_DB.prepare(`
      /* domain:persist-provider-check */
      UPDATE shop_domains
      SET cloudflare_hostname_id = ?, hostname_status = ?, ssl_status = ?, dns_status = ?,
          status = ?, is_primary = ?, validation_metadata_json = ?, last_checked_at = ?, activated_at = CASE
            WHEN ? = 'active' THEN COALESCE(activated_at, ?)
            ELSE activated_at
          END,
          next_check_at = ?, check_attempts = ?, last_safe_error_code = ?,
          lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND deleted_at IS NULL
        AND delete_requested_at IS NULL AND lease_token = ? AND version = ? AND is_primary = ?
        AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND canonical_domain_id IS ?)
        ${needsFailover && fallbackDomainId !== null ? `AND EXISTS (
          SELECT 1 FROM shop_domains fallback
          WHERE fallback.id = ? AND fallback.shop_id = ? AND fallback.type = 'platform_subdomain'
            AND fallback.status = 'active' AND fallback.delete_requested_at IS NULL AND fallback.deleted_at IS NULL
        )` : ""}
    `).bind(
      input.provider.id,
      input.provider.status,
      input.provider.ssl.status,
      input.dns.status,
      status,
      status === "active" ? row.isPrimary : 0,
      validationMetadata(input.provider, input.dns, input.turnstile, input.now.toISOString()),
      input.now.toISOString(),
      status,
      input.now.toISOString(),
      nextCheckAt(input.now, attempts, status),
      attempts,
      errorCode,
      input.now.toISOString(),
      row.id,
      row.shopId,
      input.leaseToken,
      row.version,
      row.isPrimary,
      row.shopId,
      canonicalDomainId,
      ...(needsFailover && fallbackDomainId !== null ? [fallbackDomainId, row.shopId] : []),
    ),
    reasonCode: errorCode ?? "domain_provider_not_ready",
    row: input.row,
    status,
  });
}

async function runProviderCheck(input: {
  env: AppBindings;
  leaseToken: string;
  row: DomainRow;
  runtime: DomainRuntime;
}): Promise<ProviderCheckResult> {
  const now = input.runtime.now ?? new Date();
  try {
    const client = createProvider(input.env, input.runtime);
    const provider = await recoverOrCreateProviderHostname(client, input.row);
    const dns = await (input.runtime.dnsVerifier ?? verifyCustomHostnameDns)({
      expectedTarget: getSaasTarget(input.env),
      hostname: input.row.hostname,
    });
    const turnstile = await client
      .verifyTurnstileHostnameAdmission(bindingString(input.env, "TURNSTILE_SITE_KEY"), input.row.hostname)
      .catch(() => { throw new AppError("domain_turnstile_admission_lookup_failed", 503); });
    return {
      outcome: "checked",
      row: await persistProviderCheck({ dns, env: input.env, leaseToken: input.leaseToken, now, provider, row: input.row, turnstile }),
    };
  } catch (error) {
    return {
      outcome: "failed",
      row: await persistCheckFailure({ env: input.env, error, leaseToken: input.leaseToken, now, row: input.row }),
    };
  }
}

async function claimCheckLease(input: { env: AppBindings; now: Date; row: DomainRow }): Promise<{ leaseToken: string; row: DomainRow } | null> {
  const leaseToken = createOpaqueToken(18);
  const nowIso = input.now.toISOString();
  const result = await input.env.PLATFORM_DB.prepare(`
    /* domain:claim-check-lease */
    UPDATE shop_domains
    SET lease_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND shop_id = ? AND type = 'custom' AND deleted_at IS NULL
      AND delete_requested_at IS NULL AND ownership_verified_at IS NOT NULL AND version = ?
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(
    leaseToken,
    new Date(input.now.getTime() + DOMAIN_LEASE_MS).toISOString(),
    nowIso,
    input.row.id,
    input.row.shopId,
    input.row.version,
    nowIso,
  ).run();
  if (result.meta.changes !== 1) return null;
  const row = requireDomain(await findDomainById(input.env, input.row.shopId, input.row.id));
  if (row.leaseToken !== leaseToken || row.deleteRequestedAt !== null) throw new AppError("domain_lease_lost", 409);
  return { leaseToken, row };
}

export async function listShopDomains(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<DomainView[]> {
  const { shopId } = await requireDomainActor(input.env, input.shopPublicId, input.userId, "read", false);
  const [result, claims] = await Promise.all([
    input.env.PLATFORM_DB.prepare(`${DOMAIN_SELECT}
    WHERE shop_id = ? AND deleted_at IS NULL
    ORDER BY is_primary DESC, type, created_at, id
    LIMIT 100
    `).bind(shopId).all<DomainRow>(),
    input.env.PLATFORM_DB.prepare(`${DOMAIN_CLAIM_SELECT}
      WHERE shop_id = ? AND verified_at IS NULL
      ORDER BY expires_at, created_at, id
      LIMIT 100
    `).bind(shopId).all<DomainClaimRow>(),
  ]);
  const target = getSaasTarget(input.env);
  const domains = result.results.map((row) => mapDomain(row, target));
  const pendingClaims = await Promise.all(claims.results.map((claim) => mapClaim(input.env, claim)));
  return [...domains, ...pendingClaims].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function createCustomDomain(input: {
  env: AppBindings;
  hostname: unknown;
  requestId: string;
  runtime?: DomainRuntime;
  shopPublicId: string;
  userId: string;
}): Promise<{ created: boolean; domain: DomainView }> {
  const actor = await requireDomainActor(input.env, input.shopPublicId, input.userId, "manage", true);
  const { shopId } = actor;
  const limit = actor.customDomainLimit;
  if (limit === null) throw new AppError("subscription_configuration_invalid", 500, ["custom_domain_limit_invalid"]);
  const hostname = normalizeCustomHostname(input.hostname, { platformHostnames: platformHostnames(input.env) });
  const existing = await findDomainByHostname(input.env, hostname);
  if (existing !== null) {
    if (existing.shopId !== shopId) throw new AppError("domain_already_claimed", 409);
    return { created: false, domain: mapDomain(existing, getSaasTarget(input.env)) };
  }
  const now = input.runtime?.now ?? new Date();
  const nowIso = now.toISOString();
  const existingClaim = await findClaimByHostname(input.env, shopId, hostname);
  if (existingClaim !== null && existingClaim.verifiedAt === null && existingClaim.expiresAt > nowIso) {
    return { created: false, domain: await mapClaim(input.env, existingClaim, now) };
  }
  const claimId = createId("dcl");
  const expiresAt = new Date(now.getTime() + DOMAIN_CLAIM_TTL_MS).toISOString();
  const challenge = await claimChallengeValue(input.env, { expiresAt, hostname, id: claimId, shopId });
  const challengeHash = await claimChallengeHash(input.env, challenge);
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      /* domain:create-ownership-claim */
      INSERT INTO custom_domain_claims (
        id, shop_id, hostname_normalized, challenge_hash, expires_at,
        verified_at, last_checked_at, check_attempts, last_safe_error_code,
        version, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, 1, ?, ?
      WHERE (
        SELECT COUNT(*) FROM shop_domains
        WHERE shop_id = ? AND type = 'custom' AND deleted_at IS NULL
      ) + (
        SELECT COUNT(*) FROM custom_domain_claims
        WHERE shop_id = ? AND verified_at IS NULL AND expires_at > ?
      ) < ?
      ON CONFLICT(shop_id, hostname_normalized) DO UPDATE SET
        id = excluded.id,
        challenge_hash = excluded.challenge_hash,
        expires_at = excluded.expires_at,
        verified_at = NULL,
        last_checked_at = NULL,
        check_attempts = 0,
        last_safe_error_code = NULL,
        version = custom_domain_claims.version + 1,
        updated_at = excluded.updated_at
      WHERE (
          custom_domain_claims.verified_at IS NULL
          AND custom_domain_claims.expires_at <= excluded.updated_at
        ) OR (
          custom_domain_claims.verified_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM shop_domains existing_domain
            WHERE existing_domain.hostname_normalized = custom_domain_claims.hostname_normalized
              AND existing_domain.deleted_at IS NULL
              AND (
                existing_domain.type = 'platform_subdomain'
                OR existing_domain.ownership_verified_at IS NOT NULL
              )
          )
        )
    `).bind(
      claimId, shopId, hostname, challengeHash, expiresAt, nowIso, nowIso,
      shopId, shopId, nowIso, limit,
    ),
    input.env.PLATFORM_DB.prepare(`
      /* domain:ownership-claim-audit */
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) SELECT ?, ?, 'user', ?, 'domain.ownership_claimed', 'custom_domain_claim', ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM custom_domain_claims WHERE id = ? AND shop_id = ?)
    `).bind(
      createId("aud"), shopId, input.userId, claimId,
      JSON.stringify({ hostname }), input.requestId, nowIso, claimId, shopId,
    ),
  ]);
  if (results[0]?.meta.changes !== 1) {
    const currentDomain = await findDomainByHostname(input.env, hostname);
    if (currentDomain !== null) {
      if (currentDomain.shopId !== shopId) throw new AppError("domain_already_claimed", 409);
      return { created: false, domain: mapDomain(currentDomain, getSaasTarget(input.env)) };
    }
    const currentClaim = await findClaimByHostname(input.env, shopId, hostname);
    if (currentClaim !== null && currentClaim.verifiedAt === null && currentClaim.expiresAt > nowIso) {
      return { created: false, domain: await mapClaim(input.env, currentClaim, now) };
    }
    throw new AppError("domain_limit_reached", 409);
  }
  if (results[1]?.meta.changes !== 1) throw new AppError("domain_audit_failed", 500);
  const claim = await findClaimById(input.env, shopId, claimId);
  if (claim === null) throw new AppError("domain_claim_lost", 409);
  return {
    created: existingClaim === null || existingClaim.expiresAt <= nowIso || existingClaim.verifiedAt !== null,
    domain: await mapClaim(input.env, claim, now),
  };
}

async function verifyAndPromoteClaim(input: {
  claim: DomainClaimRow;
  env: AppBindings;
  requestId: string;
  runtime: DomainRuntime;
  shopId: string;
  userId: string;
}): Promise<DomainView> {
  const now = input.runtime.now ?? new Date();
  const nowIso = now.toISOString();
  const expireClaim = async (checkedAt: Date): Promise<DomainView> => {
    const checkedAtIso = checkedAt.toISOString();
    const result = await input.env.PLATFORM_DB.prepare(`
      UPDATE custom_domain_claims
      SET last_checked_at = ?, last_safe_error_code = 'domain_ownership_expired', updated_at = ?, version = version + 1
      WHERE id = ? AND shop_id = ? AND version = ? AND verified_at IS NULL
    `).bind(checkedAtIso, checkedAtIso, input.claim.id, input.shopId, input.claim.version).run();
    if (result.meta.changes === 1) {
      return mapClaim(input.env, {
        ...input.claim,
        lastCheckedAt: checkedAtIso,
        lastSafeErrorCode: "domain_ownership_expired",
        updatedAt: checkedAtIso,
        version: input.claim.version + 1,
      }, checkedAt);
    }
    const current = await findClaimById(input.env, input.shopId, input.claim.id);
    if (current === null) throw new AppError("domain_claim_conflict", 409);
    if (current.verifiedAt !== null) return verifyAndPromoteClaim({ ...input, claim: current });
    return mapClaim(input.env, current, checkedAt);
  };
  if (input.claim.verifiedAt !== null) {
    const current = await findDomainByHostname(input.env, input.claim.hostname);
    if (current === null) throw new AppError("domain_claim_conflict", 409);
    if (current.shopId !== input.shopId) throw new AppError("domain_already_claimed", 409);
    return mapDomain(current, getSaasTarget(input.env));
  }
  if (input.claim.expiresAt <= nowIso) return expireClaim(now);
  const expectedValue = await claimChallengeValue(input.env, input.claim);
  const expectedHash = await claimChallengeHash(input.env, expectedValue);
  if (!constantTimeEqual(expectedHash, input.claim.challengeHash)) throw new AppError("domain_claim_invalid", 409);
  const ownership = await (input.runtime.ownershipVerifier ?? ((value: { challengeName: string; expectedValue: string }) => verifyCustomDomainOwnership(value)))(
    { challengeName: claimChallengeName(input.claim.hostname), expectedValue },
  );
  if (ownership.status !== "active") {
    const safeError = ownership.status === "error" ? "domain_ownership_lookup_failed" : "domain_ownership_not_verified";
    const result = await input.env.PLATFORM_DB.prepare(`
      UPDATE custom_domain_claims
      SET last_checked_at = ?, last_safe_error_code = ?, check_attempts = check_attempts + 1,
          updated_at = ?, version = version + 1
      WHERE id = ? AND shop_id = ? AND version = ? AND verified_at IS NULL
    `).bind(nowIso, safeError, nowIso, input.claim.id, input.shopId, input.claim.version).run();
    if (result.meta.changes === 1) {
      return mapClaim(input.env, { ...input.claim, checkAttempts: input.claim.checkAttempts + 1, lastCheckedAt: nowIso, lastSafeErrorCode: safeError, updatedAt: nowIso, version: input.claim.version + 1 }, now);
    }
    const current = await findClaimById(input.env, input.shopId, input.claim.id);
    if (current === null) throw new AppError("domain_claim_conflict", 409);
    if (current.verifiedAt !== null) return verifyAndPromoteClaim({ ...input, claim: current });
    return mapClaim(input.env, current, now);
  }

  const promotionNow = input.runtime.now ?? new Date();
  const promotionNowIso = promotionNow.toISOString();
  if (input.claim.expiresAt <= promotionNowIso) return expireClaim(promotionNow);

  const domainId = createId("dom");
  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        /* domain:promote-verified-claim */
        INSERT INTO shop_domains (
          id, shop_id, hostname_normalized, type, status, is_primary,
          cloudflare_hostname_id, hostname_status, ssl_status, validation_metadata_json,
          last_checked_at, activated_at, created_at, updated_at, dns_status, next_check_at,
          check_attempts, lease_token, lease_expires_at, last_safe_error_code,
          deleted_at, delete_requested_at, version, ownership_verified_at
        ) SELECT ?, shop_id, hostname_normalized, 'custom', 'pending', 0,
          NULL, NULL, NULL, '{}', NULL, NULL, ?, ?, 'pending', ?, 0, NULL, NULL, NULL,
          NULL, NULL, 1, ?
        FROM custom_domain_claims
        WHERE id = ? AND shop_id = ? AND version = ? AND verified_at IS NULL
          AND expires_at > ? AND challenge_hash = ?
          AND NOT EXISTS (
            SELECT 1 FROM shop_domains existing
            WHERE existing.hostname_normalized = custom_domain_claims.hostname_normalized
              AND existing.deleted_at IS NULL
              AND (existing.type = 'platform_subdomain' OR existing.ownership_verified_at IS NOT NULL)
          )
      `).bind(
        domainId,
        promotionNowIso,
        promotionNowIso,
        promotionNowIso,
        promotionNowIso,
        input.claim.id,
        input.shopId,
        input.claim.version,
        promotionNowIso,
        input.claim.challengeHash,
      ),
      input.env.PLATFORM_DB.prepare(`
        /* domain:mark-claim-verified */
        UPDATE custom_domain_claims
        SET verified_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND shop_id = ? AND version = ? AND verified_at IS NULL
          AND EXISTS (
            SELECT 1 FROM shop_domains
            WHERE id = ? AND shop_id = ? AND ownership_verified_at = ? AND deleted_at IS NULL
          )
      `).bind(promotionNowIso, promotionNowIso, input.claim.id, input.shopId, input.claim.version, domainId, input.shopId, promotionNowIso),
      input.env.PLATFORM_DB.prepare(`
        /* domain:verified-claim-audit */
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, created_at
        ) SELECT ?, ?, 'user', ?, 'domain.ownership_verified', 'shop_domain', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM shop_domains WHERE id = ? AND shop_id = ? AND ownership_verified_at = ?)
      `).bind(createId("aud"), input.shopId, input.userId, domainId, JSON.stringify({ hostname: input.claim.hostname }), input.requestId, promotionNowIso, domainId, input.shopId, promotionNowIso),
    ]);
    const promotionChanges = results.map((result) => result.meta.changes);
    if (promotionChanges.every((changes) => changes === 0)) {
      const current = await findDomainByHostname(input.env, input.claim.hostname);
      if (current !== null && current.shopId !== input.shopId) throw new AppError("domain_already_claimed", 409);
      if (current !== null) return mapDomain(current, getSaasTarget(input.env));
      throw new AppError("domain_claim_conflict", 409);
    }
    if (!promotionChanges.every((changes) => changes === 1)) throw new AppError("domain_audit_failed", 500);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const current = await findDomainByHostname(input.env, input.claim.hostname);
    if (current !== null && current.shopId !== input.shopId) throw new AppError("domain_already_claimed", 409);
    if (current !== null) return mapDomain(current, getSaasTarget(input.env));
    throw new AppError("domain_claim_conflict", 409);
  }

  const row = requireDomain(await findDomainById(input.env, input.shopId, domainId));
  const lease = await claimCheckLease({ env: input.env, now, row });
  if (lease === null) return mapDomain(row, getSaasTarget(input.env));
  return mapDomain((await runProviderCheck({ env: input.env, leaseToken: lease.leaseToken, row: lease.row, runtime: input.runtime })).row, getSaasTarget(input.env));
}

export async function checkCustomDomain(input: {
  domainId: string;
  env: AppBindings;
  requestId: string;
  runtime?: DomainRuntime;
  shopPublicId: string;
  userId: string;
}): Promise<DomainView> {
  const runtime = input.runtime ?? {};
  // Checking a claim/domain mutates provider state and consumes a reconciliation
  // lease, so read-only members must not be able to trigger it.
  const { shopId } = await requireDomainActor(input.env, input.shopPublicId, input.userId, "manage", false);
  const claim = await findClaimById(input.env, shopId, input.domainId);
  if (claim !== null) {
    return verifyAndPromoteClaim({
      claim,
      env: input.env,
      requestId: input.requestId,
      runtime,
      shopId,
      userId: input.userId,
    });
  }
  const row = requireDomain(await findDomainById(input.env, shopId, input.domainId));
  if (row.type !== "custom" || row.deleteRequestedAt !== null || row.ownershipVerifiedAt === null) {
    throw new AppError("domain_not_checkable", 409);
  }
  const lease = await claimCheckLease({ env: input.env, now: runtime.now ?? new Date(), row });
  if (lease === null) {
    const current = requireDomain(await findDomainById(input.env, shopId, row.id));
    if (current.deleteRequestedAt !== null) throw new AppError("domain_not_checkable", 409);
    throw new AppError("domain_check_in_progress", 409);
  }
  const checked = (await runProviderCheck({ env: input.env, leaseToken: lease.leaseToken, row: lease.row, runtime })).row;
  const checkedAt = (runtime.now ?? new Date()).toISOString();
  await input.env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (
      id, shop_id, actor_type, actor_id, action, resource_type,
      resource_id, safe_metadata_json, request_id, created_at
    ) VALUES (?, ?, 'user', ?, 'domain.checked', 'shop_domain', ?, ?, ?, ?)
  `).bind(
    createId("aud"),
    shopId,
    input.userId,
    checked.id,
    JSON.stringify({ dnsStatus: checked.dnsStatus, hostnameStatus: checked.hostnameStatus, sslStatus: checked.sslStatus, status: checked.status, turnstileStatus: mapDomain(checked, getSaasTarget(input.env)).turnstileStatus }),
    input.requestId,
    checkedAt,
  ).run();
  return mapDomain(checked, getSaasTarget(input.env));
}

export async function setPrimaryDomain(input: {
  domainId: string;
  env: AppBindings;
  requestId: string;
  runtime?: Pick<DomainRuntime, "now">;
  shopPublicId: string;
  userId: string;
}): Promise<DomainView> {
  const { shopId } = await requireDomainActor(input.env, input.shopPublicId, input.userId, "manage", false);
  const row = requireDomain(await findDomainById(input.env, shopId, input.domainId));
  if (row.type === "custom") {
    await requireDomainActor(input.env, input.shopPublicId, input.userId, "manage", true);
    if (row.ownershipVerifiedAt === null) throw new AppError("domain_not_ready", 409);
  }
  if (row.status !== "active" || row.deleteRequestedAt !== null) throw new AppError("domain_not_ready", 409);
  if (row.type === "custom" && !isCloudflareHostnameReady({
    dnsStatus: row.dnsStatus ?? "",
    hostnameStatus: row.hostnameStatus ?? "",
    sslStatus: row.sslStatus ?? "",
  })) throw new AppError("domain_not_ready", 409);
  const nowDate = input.runtime?.now ?? new Date();
  if (row.type === "custom" && !hasFreshExactTurnstileAdmission({
    hostname: row.hostname,
    now: nowDate,
    validationMetadataJson: row.validationMetadataJson,
  })) throw new AppError("domain_not_ready", 409);

  const now = nowDate.toISOString();
  const shop = await input.env.PLATFORM_DB.prepare(`
    SELECT canonical_domain_id AS canonicalDomainId FROM shops WHERE id = ? LIMIT 1
  `).bind(shopId).first<{ canonicalDomainId: string | null }>();
  if (row.isPrimary === 1 && shop?.canonicalDomainId === row.id) return mapDomain(row, getSaasTarget(input.env));
  const previous = await input.env.PLATFORM_DB.prepare(`
    SELECT id FROM shop_domains
    WHERE shop_id = ? AND is_primary = 1 AND deleted_at IS NULL
    LIMIT 1
  `).bind(shopId).first<{ id: string }>();
  const providerReadiness = row.type === "custom"
    ? ` AND ownership_verified_at IS NOT NULL AND hostname_status = 'active' AND ssl_status = 'active' AND dns_status = 'active'
        AND ${customDomainTurnstileAdmissionSql()}`
    : "";
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      /* domain:guard-primary-target */
      UPDATE shop_domains SET updated_at = updated_at
      WHERE id = ? AND shop_id = ? AND status = 'active' AND deleted_at IS NULL
        AND delete_requested_at IS NULL AND version = ?${providerReadiness}
    `).bind(row.id, shopId, row.version),
    input.env.PLATFORM_DB.prepare(`
      /* domain:demote-primary */
      UPDATE shop_domains
      SET is_primary = 0, version = version + 1, updated_at = ?
      WHERE shop_id = ? AND id <> ? AND is_primary = 1 AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM shop_domains target
          WHERE target.id = ? AND target.shop_id = ? AND target.status = 'active'
            AND target.deleted_at IS NULL AND target.delete_requested_at IS NULL
            AND target.version = ?${providerReadiness}
        )
    `).bind(now, shopId, row.id, row.id, shopId, row.version),
    input.env.PLATFORM_DB.prepare(`
      /* domain:promote-primary */
      UPDATE shop_domains
      SET is_primary = 1, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND status = 'active' AND deleted_at IS NULL
        AND delete_requested_at IS NULL AND version = ?${providerReadiness}
    `).bind(now, row.id, shopId, row.version),
    input.env.PLATFORM_DB.prepare(`
      /* domain:set-canonical */
      UPDATE shops
      SET canonical_domain_id = ?, readiness_version = readiness_version + 1, updated_at = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM shop_domains target
        WHERE target.id = ? AND target.shop_id = shops.id AND target.is_primary = 1
          AND target.status = 'active' AND target.deleted_at IS NULL
          AND target.delete_requested_at IS NULL AND target.version = ?
          ${row.type === "custom" ? `AND target.ownership_verified_at IS NOT NULL
          AND target.hostname_status = 'active' AND target.ssl_status = 'active' AND target.dns_status = 'active'
          AND ${customDomainTurnstileAdmissionSql("target")}` : ""}
      )
    `).bind(row.id, now, shopId, row.id, row.version + 1),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) SELECT ?, ?, 'user', ?, 'domain.primary_changed', 'shop_domain', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM shop_domains target
        WHERE target.id = ? AND target.shop_id = ? AND target.is_primary = 1
          AND target.status = 'active' AND target.deleted_at IS NULL
          AND target.delete_requested_at IS NULL AND target.version = ?
      )
    `).bind(
      createId("aud"),
      shopId,
      input.userId,
      row.id,
      JSON.stringify({ previousDomainId: previous?.id ?? null }),
      input.requestId,
      now,
      row.id,
      shopId,
      row.version + 1,
    ),
  ]);
  if (results[0]?.meta.changes !== 1) throw new AppError("domain_not_ready", 409);
  if (results[2]?.meta.changes !== 1 || results[3]?.meta.changes !== 1) {
    throw new AppError("domain_primary_conflict", 409);
  }
  return mapDomain(requireDomain(await findDomainById(input.env, shopId, row.id)), getSaasTarget(input.env));
}

async function finalizeProviderDeletion(input: {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  provider: DomainProvider;
  row: DomainRow;
}): Promise<void> {
  let providerId = input.row.cloudflareHostnameId;
  if (providerId === null) providerId = (await input.provider.findCustomHostname(input.row.hostname))?.id ?? null;
  if (providerId !== null) {
    try {
      await input.provider.deleteCustomHostname(providerId);
    } catch (error) {
      if (!(error instanceof CloudflareProviderError) || error.code !== "cloudflare_hostname_not_found") throw error;
    }
  }
  const nowIso = input.now.toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE shop_domains
      SET status = 'deleted', is_primary = 0, deleted_at = ?, next_check_at = NULL,
          lease_token = NULL, lease_expires_at = NULL, last_safe_error_code = NULL,
          version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND deleted_at IS NULL
        AND delete_requested_at IS NOT NULL AND lease_token = ?
    `).bind(nowIso, nowIso, input.row.id, input.row.shopId, input.leaseToken),
    input.env.PLATFORM_DB.prepare(`
      DELETE FROM custom_domain_claims
      WHERE shop_id = ? AND hostname_normalized = ? AND verified_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM shop_domains
          WHERE id = ? AND shop_id = ? AND status = 'deleted' AND deleted_at = ?
        )
    `).bind(input.row.shopId, input.row.hostname, input.row.id, input.row.shopId, nowIso),
  ]);
  if (results[0]?.meta.changes !== 1) throw new AppError("domain_lease_lost", 409);
}

async function persistDeleteFailure(input: { env: AppBindings; error: unknown; leaseToken: string; now: Date; row: DomainRow }): Promise<void> {
  const attempts = input.row.checkAttempts + 1;
  const result = await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_domains
    SET check_attempts = ?, next_check_at = ?, last_checked_at = ?,
        last_safe_error_code = ?, lease_token = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND deleted_at IS NULL
      AND delete_requested_at IS NOT NULL AND lease_token = ?
  `).bind(
    attempts,
    nextCheckAt(input.now, attempts, "validating"),
    input.now.toISOString(),
    safeProviderError(input.error),
    input.now.toISOString(),
    input.row.id,
    input.row.shopId,
    input.leaseToken,
  ).run();
  if (result.meta.changes !== 1) throw new AppError("domain_lease_lost", 409);
}

async function findActivePaymentAttempt(env: AppBindings, shopId: string, domainId: string, nowIso: string): Promise<{ id: string } | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id FROM payment_attempts
    WHERE shop_id = ? AND checkout_domain_id = ?
      AND state IN ('creating', 'pending', 'error') AND expires_at > ?
    LIMIT 1
  `).bind(shopId, domainId, nowIso).first<{ id: string }>();
}

async function claimDeleteLease(input: { env: AppBindings; now: Date; row: DomainRow }): Promise<{ leaseToken: string; row: DomainRow } | null> {
  const leaseToken = createOpaqueToken(18);
  const nowIso = input.now.toISOString();
  const result = await input.env.PLATFORM_DB.prepare(`
    /* domain:claim-delete-lease */
    UPDATE shop_domains
    SET lease_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND shop_id = ? AND type = 'custom' AND deleted_at IS NULL
      AND delete_requested_at IS NOT NULL AND version = ?
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(
    leaseToken,
    new Date(input.now.getTime() + DOMAIN_LEASE_MS).toISOString(),
    nowIso,
    input.row.id,
    input.row.shopId,
    input.row.version,
    nowIso,
  ).run();
  if (result.meta.changes !== 1) return null;
  const row = requireDomain(await findDomainById(input.env, input.row.shopId, input.row.id));
  return row.leaseToken === leaseToken ? { leaseToken, row } : null;
}

export async function deleteCustomDomain(input: {
  domainId: string;
  env: AppBindings;
  requestId: string;
  runtime?: DomainRuntime;
  shopPublicId: string;
  userId: string;
}): Promise<void> {
  const runtime = input.runtime ?? {};
  const { shopId } = await requireDomainActor(input.env, input.shopPublicId, input.userId, "manage", false);
  const claim = await findClaimById(input.env, shopId, input.domainId);
  if (claim !== null && claim.verifiedAt === null) {
    const nowIso = (runtime.now ?? new Date()).toISOString();
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, created_at
        ) SELECT ?, ?, 'user', ?, 'domain.ownership_claim_cancelled', 'custom_domain_claim', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM custom_domain_claims
          WHERE id = ? AND shop_id = ? AND version = ? AND verified_at IS NULL
        )
      `).bind(
        createId("aud"),
        shopId,
        input.userId,
        claim.id,
        JSON.stringify({ hostname: claim.hostname }),
        input.requestId,
        nowIso,
        claim.id,
        shopId,
        claim.version,
      ),
      input.env.PLATFORM_DB.prepare(`
        DELETE FROM custom_domain_claims
        WHERE id = ? AND shop_id = ? AND version = ? AND verified_at IS NULL
      `).bind(claim.id, shopId, claim.version),
    ]);
    if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) return;
    const current = await findClaimById(input.env, shopId, claim.id);
    if (current === null) return;
    throw new AppError("domain_claim_conflict", 409);
  }
  let row = await findDomainById(input.env, shopId, input.domainId);
  if (row?.deletedAt !== null && row?.deletedAt !== undefined) return;
  row = requireDomain(row);
  if (row.type !== "custom") throw new AppError("domain_platform_managed", 409);

  const now = runtime.now ?? new Date();
  const nowIso = now.toISOString();
  let ownedLeaseToken: string | null = null;

  for (let attempt = 0; row.deleteRequestedAt === null && attempt < 3; attempt += 1) {
    row = requireDomain(await findDomainById(input.env, shopId, row.id));
    if (row.deleteRequestedAt !== null) break;
    const shop = await input.env.PLATFORM_DB.prepare(`
      SELECT canonical_domain_id AS canonicalDomainId FROM shops WHERE id = ? LIMIT 1
    `).bind(shopId).first<{ canonicalDomainId: string | null }>();
    const canonicalDomainId = shop?.canonicalDomainId ?? null;
    const needsFallback = row.isPrimary === 1 || canonicalDomainId === row.id;
    const fallback = needsFallback
      ? await input.env.PLATFORM_DB.prepare(`
          SELECT id FROM shop_domains
          WHERE shop_id = ? AND type = 'platform_subdomain' AND status = 'active'
            AND delete_requested_at IS NULL AND deleted_at IS NULL
          ORDER BY created_at, id LIMIT 1
        `).bind(shopId).first<{ id: string }>()
      : null;
    if (needsFallback && fallback === null) throw new AppError("domain_fallback_unavailable", 409);

    const leaseToken = createOpaqueToken(18);
    const leaseExpiresAt = new Date(now.getTime() + DOMAIN_LEASE_MS).toISOString();
    const fallbackGuard = fallback === null ? "" : `
      AND EXISTS (
        SELECT 1 FROM shop_domains fallback
        WHERE fallback.id = ? AND fallback.shop_id = ? AND fallback.type = 'platform_subdomain'
          AND fallback.status = 'active' AND fallback.delete_requested_at IS NULL AND fallback.deleted_at IS NULL
      )`;
    const markerVersion = row.version + 1;
    const statements: D1PreparedStatement[] = [input.env.PLATFORM_DB.prepare(`
      /* domain:request-delete */
      UPDATE shop_domains
      SET status = 'suspended', is_primary = 0, delete_requested_at = ?, next_check_at = ?,
          last_safe_error_code = NULL,
          lease_token = CASE
            WHEN lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? THEN ?
            ELSE lease_token
          END,
          lease_expires_at = CASE
            WHEN lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? THEN ?
            ELSE lease_expires_at
          END,
          version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND type = 'custom' AND deleted_at IS NULL
        AND delete_requested_at IS NULL AND version = ? AND is_primary = ?
        AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND canonical_domain_id IS ?)
        AND NOT EXISTS (
          SELECT 1 FROM payment_attempts
          WHERE shop_id = ? AND checkout_domain_id = ?
            AND state IN ('creating', 'pending', 'error') AND expires_at > ?
        )${fallbackGuard}
    `).bind(
      nowIso,
      nowIso,
      nowIso,
      leaseToken,
      nowIso,
      leaseExpiresAt,
      nowIso,
      row.id,
      shopId,
      row.version,
      row.isPrimary,
      shopId,
      canonicalDomainId,
      shopId,
      row.id,
      nowIso,
      ...(fallback === null ? [] : [fallback.id, shopId]),
    )];

    if (fallback !== null) {
      statements.push(input.env.PLATFORM_DB.prepare(`
        /* domain:delete-demote-routing */
        UPDATE shop_domains
        SET is_primary = 0, version = version + 1, updated_at = ?
        WHERE shop_id = ? AND id <> ? AND is_primary = 1 AND deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM shop_domains target
            WHERE target.id = ? AND target.shop_id = ? AND target.delete_requested_at = ?
              AND target.status = 'suspended' AND target.version = ?
          )
      `).bind(nowIso, shopId, row.id, row.id, shopId, nowIso, markerVersion));
      statements.push(input.env.PLATFORM_DB.prepare(`
        /* domain:delete-promote-fallback */
        UPDATE shop_domains
        SET is_primary = 1, version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND type = 'platform_subdomain' AND status = 'active'
          AND delete_requested_at IS NULL AND deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM shop_domains target
            WHERE target.id = ? AND target.shop_id = ? AND target.delete_requested_at = ?
              AND target.status = 'suspended' AND target.version = ?
          )
      `).bind(nowIso, fallback.id, shopId, row.id, shopId, nowIso, markerVersion));
      statements.push(input.env.PLATFORM_DB.prepare(`
        /* domain:delete-set-fallback-canonical */
        UPDATE shops SET canonical_domain_id = ?, readiness_version = readiness_version + 1, updated_at = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM shop_domains target
          WHERE target.id = ? AND target.shop_id = shops.id AND target.delete_requested_at = ?
            AND target.status = 'suspended' AND target.version = ?
        ) AND EXISTS (
          SELECT 1 FROM shop_domains fallback
          WHERE fallback.id = ? AND fallback.shop_id = shops.id AND fallback.is_primary = 1
            AND fallback.status = 'active' AND fallback.deleted_at IS NULL
        )
      `).bind(fallback.id, nowIso, shopId, row.id, nowIso, markerVersion, fallback.id));
    }
    statements.push(input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) SELECT ?, ?, 'user', ?, 'domain.delete_requested', 'shop_domain', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM shop_domains target
        WHERE target.id = ? AND target.shop_id = ? AND target.delete_requested_at = ?
          AND target.status = 'suspended' AND target.version = ?
      )
    `).bind(
      createId("aud"),
      shopId,
      input.userId,
      row.id,
      JSON.stringify({ hostname: row.hostname }),
      input.requestId,
      nowIso,
      row.id,
      shopId,
      nowIso,
      markerVersion,
    ));

    const results = await input.env.PLATFORM_DB.batch(statements);
    if (results[0]?.meta.changes !== 1) {
      row = requireDomain(await findDomainById(input.env, shopId, row.id));
      if (row.deleteRequestedAt !== null) continue;
      if (await findActivePaymentAttempt(input.env, shopId, row.id, nowIso) !== null) {
        throw new AppError("domain_in_use", 409, ["active_payment_attempt"]);
      }
      continue;
    }
    if (fallback !== null && (results[2]?.meta.changes !== 1 || results[3]?.meta.changes !== 1)) {
      throw new AppError("domain_routing_conflict", 409);
    }
    row = requireDomain(await findDomainById(input.env, shopId, row.id));
    if (row.leaseToken === leaseToken) ownedLeaseToken = leaseToken;
  }

  if (row.deleteRequestedAt === null) throw new AppError("domain_delete_conflict", 409);
  if (ownedLeaseToken === null) {
    const lease = await claimDeleteLease({ env: input.env, now, row });
    if (lease === null) return;
    ownedLeaseToken = lease.leaseToken;
    row = lease.row;
  }

  try {
    await finalizeProviderDeletion({ env: input.env, leaseToken: ownedLeaseToken, now, provider: createProvider(input.env, runtime), row });
    await input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (?, ?, 'user', ?, 'domain.deleted', 'shop_domain', ?, '{}', ?, ?)
    `).bind(createId("aud"), shopId, input.userId, row.id, input.requestId, nowIso).run();
  } catch (error) {
    await persistDeleteFailure({ env: input.env, error, leaseToken: ownedLeaseToken, now, row });
    throw error instanceof AppError ? error : new AppError("provider_unavailable", 503);
  }
}

export async function reconcileCustomDomainRecord(input: {
  env: AppBindings;
  leaseToken: string;
  now: Date;
  row: { id: string; shopId: string };
  runtime?: Omit<DomainRuntime, "now">;
}): Promise<"checked" | "deleted" | "failed"> {
  const row = requireDomain(await findDomainById(input.env, input.row.shopId, input.row.id));
  const runtime: DomainRuntime = { ...(input.runtime ?? {}), now: input.now };
  if (row.leaseToken !== input.leaseToken) throw new AppError("domain_lease_lost", 409);
  if (row.deleteRequestedAt !== null) {
    try {
      await finalizeProviderDeletion({ env: input.env, leaseToken: input.leaseToken, now: input.now, provider: createProvider(input.env, runtime), row });
      return "deleted";
    } catch (error) {
      await persistDeleteFailure({ env: input.env, error, leaseToken: input.leaseToken, now: input.now, row });
      throw error;
    }
  }
  return (await runProviderCheck({ env: input.env, leaseToken: input.leaseToken, row, runtime })).outcome;
}
