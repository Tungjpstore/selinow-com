import { describe, expect, it, vi } from "vitest";

import type { CloudflareCustomHostname } from "../../src/lib/domains/cloudflare";
import { reconcileCustomDomains } from "../../src/lib/domains/reconciliation";
import { checkCustomDomain, createCustomDomain as createCustomDomainClaim, customDomainBackoffSeconds, deleteCustomDomain, listShopDomains, setPrimaryDomain, type DomainProvider } from "../../src/lib/domains/store";
import type { AppBindings } from "../../src/lib/platform/bindings";

type FakeDomain = {
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
  ownershipVerifiedAt?: string | null;
  shopId: string;
  sslStatus: string | null;
  status: string;
  type: "custom" | "platform_subdomain";
  updatedAt: string;
  validationMetadataJson: string;
  version: number;
};

type FakeClaim = {
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

const NOW = new Date("2026-07-26T00:00:00.000Z");

function platformDomain(shopId: string): FakeDomain {
  return {
    activatedAt: NOW.toISOString(), checkAttempts: 0, cloudflareHostnameId: null,
    createdAt: NOW.toISOString(), deleteRequestedAt: null, deletedAt: null, dnsStatus: null,
    hostname: `${shopId}.staging.selinow.com`, hostnameStatus: null, id: `dom_platform_${shopId}`,
    isPrimary: 1, lastCheckedAt: null, lastSafeErrorCode: null, leaseExpiresAt: null, leaseToken: null,
    nextCheckAt: null, shopId, sslStatus: null, status: "active", type: "platform_subdomain",
            updatedAt: NOW.toISOString(), validationMetadataJson: "{}", version: 1,
  };
}

class DomainDatabase {
  activePaymentDomainId: string | null = null;
  afterMutationBatch: (() => Promise<void>) | null = null;
  readonly auditActions: string[] = [];
  beforeClaimExpiryUpdate: (() => void) | null = null;
  beforeDeleteRequest: (() => void) | null = null;
  beforePrimaryGuard: (() => void) | null = null;
  beforeRestoreUpdate: (() => Promise<void>) | null = null;
  readonly domains = new Map<string, FakeDomain>();
  readonly canonical = new Map<string, string>();
  readonly claims = new Map<string, FakeClaim>();
  readonly customDomainFeature = new Map([["shop-a", true], ["shop-b", true]]);
  readonly customDomainLimits = new Map<string, unknown>([["shop-a", 5], ["shop-b", 5]]);
  failVerifiedClaimAudit = false;

  constructor() {
    for (const shopId of ["shop-a", "shop-b"]) {
      const domain = platformDomain(shopId);
      this.domains.set(domain.id, domain);
      this.canonical.set(shopId, domain.id);
    }
  }

  prepare(sql: string) {
    const activePaymentDomainId = () => this.activePaymentDomainId;
    const failVerifiedClaimAudit = () => this.failVerifiedClaimAudit;
    const runBeforeClaimExpiryUpdate = () => {
      this.beforeClaimExpiryUpdate?.();
      this.beforeClaimExpiryUpdate = null;
    };
    const runBeforeDeleteRequest = () => {
      this.beforeDeleteRequest?.();
      this.beforeDeleteRequest = null;
    };
    const runBeforePrimaryGuard = () => {
      this.beforePrimaryGuard?.();
      this.beforePrimaryGuard = null;
    };
    const runBeforeRestoreUpdate = () => this.beforeRestoreUpdate?.() ?? Promise.resolve();
    const auditActions = this.auditActions;
    const canonical = this.canonical;
    const claims = this.claims;
    const customDomainFeature = this.customDomainFeature;
    const customDomainLimits = this.customDomainLimits;
    const domains = this.domains;
    return {
      bind(...values: unknown[]) {
        const statement = {
          all() {
            if (sql.includes("FROM custom_domain_claims")) {
              return Promise.resolve({ results: Array.from(claims.values()).filter((row) => row.shopId === values[0]) });
            }
            if (sql.includes("FROM shop_domains") && sql.includes("next_check_at <= ?")) {
              const now = String(values[0]);
              return Promise.resolve({ results: Array.from(domains.values()).filter((row) => row.type === "custom" && row.deletedAt === null && row.nextCheckAt !== null && row.nextCheckAt <= now && (row.leaseExpiresAt === null || row.leaseExpiresAt <= now)).map((row) => ({ id: row.id, shopId: row.shopId })) });
            }
            if (sql.includes("FROM shop_domains") && sql.includes("ORDER BY is_primary")) {
              return Promise.resolve({ results: Array.from(domains.values()).filter((row) => row.shopId === values[0] && row.deletedAt === null) });
            }
            return Promise.resolve({ results: [] });
          },
          first() {
            if (sql.includes("FROM shops") && sql.includes("INNER JOIN shop_members")) {
              const userId = String(values[0]);
              const shopPublicId = String(values[1]);
              const shopId = userId === "user-a" && shopPublicId === "shop_public_a"
                ? "shop-a"
                : userId === "user-b" && shopPublicId === "shop_public_b"
                  ? "shop-b"
                  : null;
              return Promise.resolve(shopId === null ? null : {
                currency: "VND", default_locale: "vi", feature_flags_json: JSON.stringify({ customDomain: customDomainFeature.get(shopId) }),
                limits_json: customDomainLimits.has(shopId) ? JSON.stringify({ customDomains: customDomainLimits.get(shopId) }) : "{}",
                name: shopId, plan_code: "business", public_id: shopPublicId, role: "owner", shop_id: shopId,
                shop_status: "active", slug: shopId, subscription_state: "active", timezone: "Asia/Ho_Chi_Minh",
              });
            }
            if (sql.includes("AS liveCount") && sql.includes("custom_domain_claims")) {
              const now = String(values[2]);
              const liveCount = Array.from(domains.values()).filter((row) => (
                row.shopId === values[0] && row.type === "custom" && row.deletedAt === null
              )).length + Array.from(claims.values()).filter((row) => row.shopId === values[1] && row.verifiedAt === null && row.expiresAt > now).length;
              return Promise.resolve({ liveCount });
            }
            if (sql.includes("FROM custom_domain_claims") && sql.includes("WHERE id = ? AND shop_id = ?")) {
              const row = claims.get(String(values[0]));
              return Promise.resolve(row?.shopId === values[1] ? row : null);
            }
            if (sql.includes("FROM custom_domain_claims") && sql.includes("WHERE shop_id = ? AND hostname_normalized = ?")) {
              return Promise.resolve(Array.from(claims.values()).find((row) => row.shopId === values[0] && row.hostname === values[1]) ?? null);
            }
            if (sql.includes("FROM shop_domains") && sql.includes("hostname_normalized = ?")) {
              return Promise.resolve(Array.from(domains.values()).find((row) => row.hostname === values[0] && row.deletedAt === null) ?? null);
            }
            if (sql.includes("FROM shop_domains") && sql.includes("WHERE id = ? AND shop_id = ?")) {
              const row = domains.get(String(values[0]));
              return Promise.resolve(row?.shopId === values[1] ? row : null);
            }
            if (sql.includes("SELECT id FROM shop_domains") && sql.includes("is_primary = 1")) {
              const row = Array.from(domains.values()).find((candidate) => candidate.shopId === values[0] && candidate.isPrimary === 1 && candidate.deletedAt === null);
              return Promise.resolve(row === undefined ? null : { id: row.id });
            }
            if (sql.includes("SELECT id FROM shop_domains") && sql.includes("type = 'platform_subdomain'")) {
              const row = Array.from(domains.values()).find((candidate) => candidate.shopId === values[0] && candidate.type === "platform_subdomain" && candidate.status === "active" && candidate.deletedAt === null);
              return Promise.resolve(row === undefined ? null : { id: row.id });
            }
            if (sql.includes("SELECT id FROM payment_attempts")) {
              return Promise.resolve(activePaymentDomainId() === values[1] ? { id: "payment-attempt" } : null);
            }
            if (sql.includes("SELECT canonical_domain_id AS canonicalDomainId FROM shops")) {
              return Promise.resolve({ canonicalDomainId: canonical.get(String(values[0])) ?? null });
            }
            return Promise.resolve(null);
          },
          run() {
            if (sql.includes("domain:create-ownership-claim")) {
              const [idValue, shopIdValue, hostnameValue, challengeHashValue, expiresAtValue, createdAtValue, updatedAtValue] = values;
              const id = String(idValue);
              const shopId = String(shopIdValue);
              const hostname = String(hostnameValue);
              const existing = Array.from(claims.values()).find((row) => row.shopId === shopId && row.hostname === hostname);
              const limit = Number(values.at(-1));
              const now = String(values.at(-2));
              const liveCount = Array.from(domains.values()).filter((row) => row.shopId === shopId && row.type === "custom" && row.deletedAt === null).length
                + Array.from(claims.values()).filter((row) => row.shopId === shopId && row.verifiedAt === null && row.expiresAt > now).length;
              if (existing !== undefined && existing.verifiedAt === null && existing.expiresAt > now) return Promise.resolve({ meta: { changes: 0 } });
              if (liveCount >= limit) return Promise.resolve({ meta: { changes: 0 } });
              if (existing !== undefined) claims.delete(existing.id);
              claims.set(id, {
                challengeHash: String(challengeHashValue),
                checkAttempts: 0,
                createdAt: existing?.createdAt ?? String(createdAtValue),
                expiresAt: String(expiresAtValue),
                hostname,
                id,
                lastCheckedAt: null,
                lastSafeErrorCode: null,
                shopId,
                updatedAt: String(updatedAtValue),
                verifiedAt: null,
                version: (existing?.version ?? 0) + 1,
              });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:promote-verified-claim")) {
              const domainId = String(values[0]);
              const claim = Array.from(claims.values()).find((row) => values.includes(row.id));
              const ownershipVerifiedAt = String(values[4]);
              const conflict = claim === undefined ? undefined : Array.from(domains.values()).find((row) => row.hostname === claim.hostname && row.deletedAt === null);
              if (
                claim === undefined
                || claim.shopId !== values[6]
                || claim.version !== values[7]
                || claim.verifiedAt !== null
                || claim.expiresAt <= String(values[8])
                || claim.challengeHash !== values[9]
                || conflict !== undefined
              ) return Promise.resolve({ meta: { changes: 0 } });
              domains.set(domainId, {
                activatedAt: null,
                checkAttempts: 0,
                cloudflareHostnameId: null,
                createdAt: ownershipVerifiedAt,
                deleteRequestedAt: null,
                deletedAt: null,
                dnsStatus: "pending",
                hostname: claim.hostname,
                hostnameStatus: null,
                id: domainId,
                isPrimary: 0,
                lastCheckedAt: null,
                lastSafeErrorCode: null,
                leaseExpiresAt: null,
                leaseToken: null,
                nextCheckAt: ownershipVerifiedAt,
                ownershipVerifiedAt,
                shopId: claim.shopId,
                sslStatus: null,
                status: "pending",
                type: "custom",
                updatedAt: ownershipVerifiedAt,
                validationMetadataJson: "{}",
                version: 1,
              });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:mark-claim-verified")) {
              const claim = Array.from(claims.values()).find((row) => row.id === values[2] && row.shopId === values[3]);
              const domain = domains.get(String(values[5]));
              if (
                claim === undefined
                || claim.verifiedAt !== null
                || claim.version !== values[4]
                || domain === undefined
                || domain.shopId !== values[6]
                || domain.ownershipVerifiedAt !== values[7]
                || domain.deletedAt !== null
              ) return Promise.resolve({ meta: { changes: 0 } });
              Object.assign(claim, { updatedAt: values[1], verifiedAt: values[0], version: claim.version + 1 });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("UPDATE custom_domain_claims") && sql.includes("last_safe_error_code")) {
              const expired = sql.includes("domain_ownership_expired");
              if (expired) runBeforeClaimExpiryUpdate();
              const claimId = String(values[expired ? 2 : 3]);
              const claim = claims.get(claimId);
              const shopId = values[expired ? 3 : 4];
              const version = values[expired ? 4 : 5];
              if (claim === undefined || claim.shopId !== shopId || claim.version !== version || claim.verifiedAt !== null) {
                return Promise.resolve({ meta: { changes: 0 } });
              }
              const safeError = expired ? "domain_ownership_expired" : String(values[1]);
              Object.assign(claim, {
                checkAttempts: safeError === "domain_ownership_expired" ? claim.checkAttempts : claim.checkAttempts + 1,
                lastCheckedAt: values[0],
                lastSafeErrorCode: safeError,
                updatedAt: safeError === "domain_ownership_expired" ? values[1] : values[2],
                version: claim.version + 1,
              });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("DELETE FROM custom_domain_claims")) {
              if (sql.includes("hostname_normalized = ?")) {
                const claim = Array.from(claims.values()).find((row) => row.shopId === values[0] && row.hostname === values[1] && row.verifiedAt !== null);
                const domain = domains.get(String(values[2]));
                if (claim === undefined || domain === undefined || domain.shopId !== values[3] || domain.status !== "deleted" || domain.deletedAt !== values[4]) {
                  return Promise.resolve({ meta: { changes: 0 } });
                }
                claims.delete(claim.id);
                return Promise.resolve({ meta: { changes: 1 } });
              }
              const claim = claims.get(String(values[0]));
              if (claim === undefined || claim.shopId !== values[1]) return Promise.resolve({ meta: { changes: 0 } });
              claims.delete(claim.id);
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("INSERT INTO shop_domains")) {
              const id = String(values[0]);
              const shopId = String(values[1]);
              const hostname = String(values[2]);
              const nextCheckAt = String(values[3]);
              const createdAt = String(values[4]);
              const updatedAt = String(values[5]);
              if (sql.includes("domain:create-with-quota")) {
                const quotaShopId = String(values[6]);
                const limit = Number(values[7]);
                const liveCount = Array.from(domains.values()).filter((row) => (
                  row.shopId === quotaShopId && row.type === "custom" && row.deletedAt === null
                )).length;
                if (liveCount >= limit) return Promise.resolve({ meta: { changes: 0 } });
              }
              domains.set(id, {
                activatedAt: null, checkAttempts: 0, cloudflareHostnameId: null, createdAt,
                deleteRequestedAt: null, deletedAt: null, dnsStatus: "pending", hostname,
                hostnameStatus: null, id, isPrimary: 0, lastCheckedAt: null, lastSafeErrorCode: null,
                leaseExpiresAt: null, leaseToken: null, nextCheckAt, shopId, sslStatus: null,
                status: "pending", type: "custom", updatedAt, validationMetadataJson: "{}", version: 1,
              });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:restore */")) {
              return runBeforeRestoreUpdate().then(() => {
                const row = domains.get(String(values[4]));
                const liveCount = Array.from(domains.values()).filter((candidate) => (
                  candidate.shopId === values[7] && candidate.type === "custom" && candidate.deletedAt === null
                )).length;
                if (row === undefined || row.shopId !== values[5] || row.deletedAt === null || row.version !== values[6] || liveCount >= Number(values[8])) {
                  return { meta: { changes: 0 } };
                }
                Object.assign(row, {
                  activatedAt: null,
                  checkAttempts: 0,
                  cloudflareHostnameId: null,
                  deleteRequestedAt: null,
                  deletedAt: null,
                  dnsStatus: "pending",
                  hostnameStatus: null,
                  isPrimary: 0,
                  lastCheckedAt: null,
                  lastSafeErrorCode: null,
                  leaseExpiresAt: values[2],
                  leaseToken: values[1],
                  nextCheckAt: values[0],
                  sslStatus: null,
                  status: "pending",
                  updatedAt: values[3],
                  validationMetadataJson: "{}",
                  version: row.version + 1,
                });
                return { meta: { changes: 1 } };
              });
            }
            if (sql.includes("domain:restored-audit")) {
              const row = domains.get(String(values[7]));
              const restored = row !== undefined
                && row.shopId === values[8]
                && row.deletedAt === null
                && row.leaseToken === values[9]
                && row.version === values[10];
              if (restored) auditActions.push("domain.restored");
              return Promise.resolve({ meta: { changes: restored ? 1 : 0 } });
            }
            if (sql.includes("domain:created-audit")) {
              const row = domains.get(String(values[7]));
              const created = row !== undefined
                && row.shopId === values[8]
                && row.hostname === values[9]
                && row.type === "custom"
                && row.deletedAt === null;
              if (created) auditActions.push("domain.created");
              return Promise.resolve({ meta: { changes: created ? 1 : 0 } });
            }
            if (sql.includes("domain:claim-check-lease")) {
              const row = domains.get(String(values[3]));
              const now = String(values[6]);
              if (row === undefined || row.shopId !== values[4] || row.version !== values[5] || row.deletedAt !== null || row.deleteRequestedAt !== null || (row.leaseToken !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > now)) {
                return Promise.resolve({ meta: { changes: 0 } });
              }
              Object.assign(row, { leaseExpiresAt: values[1], leaseToken: values[0], updatedAt: values[2] });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:claim-delete-lease")) {
              const row = domains.get(String(values[3]));
              const now = String(values[6]);
              if (row === undefined || row.shopId !== values[4] || row.version !== values[5] || row.deletedAt !== null || row.deleteRequestedAt === null || (row.leaseToken !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > now)) {
                return Promise.resolve({ meta: { changes: 0 } });
              }
              Object.assign(row, { leaseExpiresAt: values[1], leaseToken: values[0], updatedAt: values[2] });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:persist-provider-check")) {
              const row = domains.get(String(values[14]));
              const expectedCanonical = typeof values[20] === "string" ? values[20] : null;
              if (row === undefined || row.shopId !== values[15] || row.deleteRequestedAt !== null || row.leaseToken !== values[16] || row.version !== values[17] || row.isPrimary !== values[18] || (canonical.get(String(values[19])) ?? null) !== expectedCanonical) return Promise.resolve({ meta: { changes: 0 } });
              Object.assign(row, {
                activatedAt: values[4] === "active" ? row.activatedAt ?? values[9] : row.activatedAt,
                checkAttempts: values[11], cloudflareHostnameId: values[0], dnsStatus: values[3],
                hostnameStatus: values[1], isPrimary: values[5], lastCheckedAt: values[7], lastSafeErrorCode: values[12],
                leaseExpiresAt: null, leaseToken: null, nextCheckAt: values[10], sslStatus: values[2],
                status: values[4], updatedAt: values[13], validationMetadataJson: values[6], version: row.version + 1,
              });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("SET lease_token = ?")) {
              const row = domains.get(String(values[3]));
              const now = String(values[5]);
              if (row === undefined || row.shopId !== values[4] || row.nextCheckAt === null || row.nextCheckAt > now || (row.leaseExpiresAt !== null && row.leaseExpiresAt > now)) return Promise.resolve({ meta: { changes: 0 } });
              Object.assign(row, { leaseExpiresAt: values[1], leaseToken: values[0], updatedAt: values[2] });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:persist-check-failure")) {
              const row = domains.get(String(values[6]));
              const expectedCanonical = typeof values[12] === "string" ? values[12] : null;
              if (row === undefined || row.shopId !== values[7] || row.deleteRequestedAt !== null || row.leaseToken !== values[8] || row.version !== values[9] || row.isPrimary !== values[10] || (canonical.get(String(values[11])) ?? null) !== expectedCanonical) return Promise.resolve({ meta: { changes: 0 } });
              Object.assign(row, { checkAttempts: values[1], isPrimary: 0, lastCheckedAt: values[3], lastSafeErrorCode: values[4], leaseExpiresAt: null, leaseToken: null, nextCheckAt: values[2], status: values[0], updatedAt: values[5], version: row.version + 1 });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:check-demote-routing")) {
              const target = domains.get(String(values[3]));
              if (target === undefined || target.shopId !== values[4] || target.status !== values[5] || target.isPrimary !== 0 || target.deleteRequestedAt !== null || target.leaseToken !== null || target.version !== values[6]) return Promise.resolve({ meta: { changes: 0 } });
              let changes = 0;
              for (const candidate of domains.values()) {
                if (candidate.shopId === values[1] && candidate.id !== values[2] && candidate.isPrimary === 1 && candidate.deletedAt === null) {
                  candidate.isPrimary = 0;
                  candidate.version += 1;
                  changes += 1;
                }
              }
              return Promise.resolve({ meta: { changes } });
            }
            if (sql.includes("domain:check-promote-fallback")) {
              const fallback = domains.get(String(values[1]));
              const target = domains.get(String(values[3]));
              if (fallback === undefined || fallback.shopId !== values[2] || fallback.type !== "platform_subdomain" || fallback.status !== "active" || fallback.deleteRequestedAt !== null || fallback.deletedAt !== null || target === undefined || target.shopId !== values[4] || target.status !== values[5] || target.isPrimary !== 0 || target.leaseToken !== null || target.version !== values[6]) return Promise.resolve({ meta: { changes: 0 } });
              fallback.isPrimary = 1;
              fallback.version += 1;
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:check-set-fallback-canonical")) {
              const target = domains.get(String(values[3]));
              const fallbackId = typeof values[0] === "string" ? values[0] : null;
              const fallback = fallbackId === null ? null : domains.get(fallbackId);
              const fallbackReady = fallbackId === null || (fallback !== null && fallback !== undefined && fallback.shopId === values[2] && fallback.isPrimary === 1 && fallback.type === "platform_subdomain" && fallback.status === "active" && fallback.deleteRequestedAt === null && fallback.deletedAt === null);
              if (target === undefined || target.shopId !== values[2] || target.status !== values[4] || target.isPrimary !== 0 || target.leaseToken !== null || target.version !== values[5] || !fallbackReady) return Promise.resolve({ meta: { changes: 0 } });
              if (fallbackId === null) canonical.delete(values[2]);
              else canonical.set(values[2], fallbackId);
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:guard-primary-target")) {
              runBeforePrimaryGuard();
              const row = domains.get(String(values[0]));
              const ready = row !== undefined && row.shopId === values[1] && row.status === "active" && row.deletedAt === null && row.deleteRequestedAt === null && row.version === values[2]
                && (row.type !== "custom" || (row.ownershipVerifiedAt != null && row.hostnameStatus === "active" && row.sslStatus === "active" && row.dnsStatus === "active"));
              return Promise.resolve({ meta: { changes: ready ? 1 : 0 } });
            }
            if (sql.includes("domain:demote-primary")) {
              const target = domains.get(String(values[2]));
              if (target === undefined || target.shopId !== values[4] || target.version !== values[5] || target.status !== "active" || target.deleteRequestedAt !== null) return Promise.resolve({ meta: { changes: 0 } });
              let changes = 0;
              for (const candidate of domains.values()) {
                if (candidate.shopId === values[1] && candidate.id !== values[2] && candidate.isPrimary === 1 && candidate.deletedAt === null) {
                  candidate.isPrimary = 0;
                  candidate.version += 1;
                  changes += 1;
                }
              }
              return Promise.resolve({ meta: { changes } });
            }
            if (sql.includes("domain:promote-primary")) {
              const row = domains.get(String(values[1]));
              const ready = row !== undefined && row.shopId === values[2] && row.status === "active" && row.deletedAt === null && row.deleteRequestedAt === null && row.version === values[3]
                && (row.type !== "custom" || (row.ownershipVerifiedAt != null && row.hostnameStatus === "active" && row.sslStatus === "active" && row.dnsStatus === "active"));
              if (!ready) return Promise.resolve({ meta: { changes: 0 } });
              row.isPrimary = 1;
              row.updatedAt = String(values[0]);
              row.version += 1;
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:set-canonical")) {
              const row = domains.get(String(values[3]));
              if (row === undefined || row.shopId !== values[2] || row.isPrimary !== 1 || row.version !== values[4]) return Promise.resolve({ meta: { changes: 0 } });
              canonical.set(values[2], values[0] as string);
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:request-delete")) {
              runBeforeDeleteRequest();
              const row = domains.get(String(values[7]));
              const expectedCanonical = typeof values[12] === "string" ? values[12] : null;
              const fallbackId = values.length > 16 ? String(values[16]) : null;
              const fallback = fallbackId === null ? null : domains.get(fallbackId);
              const fallbackReady = fallbackId === null || (fallback !== null && fallback !== undefined
                && fallback.shopId === values[17] && fallback.type === "platform_subdomain" && fallback.status === "active"
                && fallback.deletedAt === null && fallback.deleteRequestedAt === null);
              const guarded = row !== undefined
                && row.shopId === values[8]
                && row.type === "custom"
                && row.deletedAt === null
                && row.deleteRequestedAt === null
                && row.version === values[9]
                && row.isPrimary === values[10]
                && (canonical.get(String(values[11])) ?? null) === expectedCanonical
                && activePaymentDomainId() !== row.id
                && fallbackReady;
              if (!guarded) return Promise.resolve({ meta: { changes: 0 } });
              const leaseAvailable = row.leaseToken === null || row.leaseExpiresAt === null || row.leaseExpiresAt <= String(values[2]);
              Object.assign(row, {
                deleteRequestedAt: values[0],
                isPrimary: 0,
                lastSafeErrorCode: null,
                leaseExpiresAt: leaseAvailable ? values[5] : row.leaseExpiresAt,
                leaseToken: leaseAvailable ? values[3] : row.leaseToken,
                nextCheckAt: values[1],
                status: "suspended",
                updatedAt: values[6],
                version: row.version + 1,
              });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:delete-demote-routing")) {
              const target = domains.get(String(values[3]));
              if (target === undefined || target.shopId !== values[4] || target.deleteRequestedAt !== values[5] || target.status !== "suspended" || target.version !== values[6]) return Promise.resolve({ meta: { changes: 0 } });
              let changes = 0;
              for (const candidate of domains.values()) {
                if (candidate.shopId === values[1] && candidate.id !== values[2] && candidate.isPrimary === 1 && candidate.deletedAt === null) {
                  candidate.isPrimary = 0;
                  candidate.version += 1;
                  changes += 1;
                }
              }
              return Promise.resolve({ meta: { changes } });
            }
            if (sql.includes("domain:delete-promote-fallback")) {
              const fallback = domains.get(String(values[1]));
              const target = domains.get(String(values[3]));
              if (fallback === undefined || fallback.shopId !== values[2] || fallback.status !== "active" || fallback.deletedAt !== null || fallback.deleteRequestedAt !== null || target === undefined || target.shopId !== values[4] || target.deleteRequestedAt !== values[5] || target.version !== values[6]) return Promise.resolve({ meta: { changes: 0 } });
              fallback.isPrimary = 1;
              fallback.version += 1;
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("domain:delete-set-fallback-canonical")) {
              const target = domains.get(String(values[3]));
              const fallback = domains.get(String(values[6]));
              if (target === undefined || target.shopId !== values[2] || target.deleteRequestedAt !== values[4] || target.version !== values[5] || fallback === undefined || fallback.isPrimary !== 1 || fallback.status !== "active") return Promise.resolve({ meta: { changes: 0 } });
              canonical.set(values[2], values[0] as string);
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("SET check_attempts = ?, next_check_at = ?")) {
              const row = domains.get(String(values[5]));
              if (row === undefined || row.shopId !== values[6] || row.deletedAt !== null || row.deleteRequestedAt === null || row.leaseToken !== values[7]) return Promise.resolve({ meta: { changes: 0 } });
              Object.assign(row, { checkAttempts: values[0], lastCheckedAt: values[2], lastSafeErrorCode: values[3], leaseExpiresAt: null, leaseToken: null, nextCheckAt: values[1], updatedAt: values[4], version: row.version + 1 });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("SET is_primary = 0")) {
              for (const row of domains.values()) {
                if (row.shopId === values[1] && row.isPrimary === 1) {
                  row.isPrimary = 0;
                  row.version += 1;
                }
              }
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("SET is_primary = 1")) {
              const row = domains.get(String(values[1]));
              if (row !== undefined && row.shopId === values[2]) {
                row.isPrimary = 1;
                row.version += 1;
              }
              return Promise.resolve({ meta: { changes: row === undefined ? 0 : 1 } });
            }
            if (sql.includes("SET status = 'suspended'")) {
              const row = domains.get(String(values[3]));
              if (row === undefined || row.shopId !== values[4]) return Promise.resolve({ meta: { changes: 0 } });
              Object.assign(row, { deleteRequestedAt: values[0], isPrimary: 0, nextCheckAt: values[1], status: "suspended", updatedAt: values[2], version: row.version + 1 });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("SET status = 'deleted'")) {
              const row = domains.get(String(values[2]));
              if (row === undefined || row.shopId !== values[3] || row.deletedAt !== null || row.deleteRequestedAt === null || row.leaseToken !== values[4]) return Promise.resolve({ meta: { changes: 0 } });
              Object.assign(row, { deletedAt: values[0], isPrimary: 0, leaseExpiresAt: null, leaseToken: null, nextCheckAt: null, status: "deleted", updatedAt: values[1], version: row.version + 1 });
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("UPDATE shops") && sql.includes("canonical_domain_id")) {
              canonical.set(String(values[2]), String(values[0]));
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("INSERT INTO audit_logs")) {
              if (sql.includes("domain:ownership-claim-audit")) auditActions.push("domain.ownership_claimed");
              if (sql.includes("domain:verified-claim-audit")) {
                const domain = domains.get(String(values[7]));
                const verified = !failVerifiedClaimAudit()
                  && domain !== undefined
                  && domain.shopId === values[8]
                  && domain.ownershipVerifiedAt === values[9];
                if (!verified) return Promise.resolve({ meta: { changes: 0 } });
                auditActions.push("domain.ownership_verified");
              }
              for (const action of ["domain.checked", "domain.deleted", "domain.primary_changed"] as const) {
                if (sql.includes(`'${action}'`)) auditActions.push(action);
              }
              return Promise.resolve({ meta: { changes: 1 } });
            }
            return Promise.resolve({ meta: { changes: 1 } });
          },
        };
        return statement;
      },
    };
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const statement of statements) results.push(await statement.run());
    const afterMutationBatch = this.afterMutationBatch;
    this.afterMutationBatch = null;
    await afterMutationBatch?.();
    return results;
  }
}

class Provider implements DomainProvider {
  creates = 0;
  deletes = 0;
  current: CloudflareCustomHostname | null;

  constructor(status = "active", sslStatus = "active") {
    this.current = null;
    this.nextStatus = status;
    this.nextSslStatus = sslStatus;
  }

  nextStatus: string;
  nextSslStatus: string;

  createCustomHostname(hostname: string): Promise<CloudflareCustomHostname> {
    this.creates += 1;
    this.current = { hostname, id: "cf-hostname-1", ssl: { status: this.nextSslStatus }, status: this.nextStatus };
    return Promise.resolve(this.current);
  }

  deleteCustomHostname(): Promise<void> { this.deletes += 1; return Promise.resolve(); }
  findCustomHostname(): Promise<CloudflareCustomHostname | null> { return Promise.resolve(this.current); }
  getCustomHostname(): Promise<CloudflareCustomHostname> {
    if (this.current === null) throw new Error("missing");
    this.current = { ...this.current, ssl: { status: this.nextSslStatus }, status: this.nextStatus };
    return Promise.resolve(this.current);
  }
}

function environment(database: DomainDatabase): AppBindings {
  return {
    API_ORIGIN: "https://api-staging.selinow.com",
    APP_ENV: "staging",
    CLOUDFLARE_API_TOKEN: "secret",
    CLOUDFLARE_ZONE_ID: "zone-id",
    DASHBOARD_ORIGIN: "https://app-staging.selinow.com",
    PLATFORM_BASE_DOMAIN: "staging.selinow.com",
    PLATFORM_DB: database,
    PLATFORM_ORIGIN: "https://staging.selinow.com",
    SAAS_CNAME_TARGET: "customers.selinow.com",
    SESSION_SECRET: "domain-store-test-session-secret",
  } as unknown as AppBindings;
}

const activeDns = () => Promise.resolve({ observedTargets: ["customers.selinow.com"], status: "active" as const });

async function createCustomDomain(input: Parameters<typeof createCustomDomainClaim>[0]): ReturnType<typeof createCustomDomainClaim> {
  const claimed = await createCustomDomainClaim(input);
  if (claimed.domain.status !== "ownership_pending") return claimed;
  const domain = await checkCustomDomain({
    domainId: claimed.domain.id,
    env: input.env,
    requestId: `${input.requestId}-ownership`,
    runtime: {
      ...input.runtime,
      ownershipVerifier: ({ expectedValue }) => Promise.resolve({ observedValues: [expectedValue], status: "active" }),
    },
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  return { created: claimed.created, domain };
}

describe("custom domain store", () => {
  it("lists platform domains without requiring the custom-hostname provider token", async () => {
    const database = new DomainDatabase();
    const env = environment(database) as AppBindings & { CLOUDFLARE_API_TOKEN?: string };
    delete env.CLOUDFLARE_API_TOKEN;

    const domains = await listShopDomains({
      env,
      shopPublicId: "shop_public_a",
      userId: "user-a",
    });

    expect(domains).toEqual([
      expect.objectContaining({
        hostname: "shop-a.staging.selinow.com",
        status: "active",
        type: "platform_subdomain",
      }),
    ]);
  });

  it("creates once and returns the same tenant-owned domain on retry", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const input = { env: environment(database), hostname: "shop.customer.com", requestId: "request-123", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" };
    const first = await createCustomDomain(input);
    const replay = await createCustomDomain(input);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.domain.id).toBe(first.domain.id);
    expect(replay.domain.status).toBe("active");
    expect(provider.creates).toBe(1);
    expect(database.auditActions.filter((action) => action === "domain.ownership_verified")).toHaveLength(1);
  });

  it("atomically grants only one request racing for the final custom-domain slot", async () => {
    const database = new DomainDatabase();
    database.customDomainLimits.set("shop-a", 1);
    const provider = new Provider();
    const base = {
      env: environment(database),
      runtime: { dnsVerifier: activeDns, now: NOW, provider },
      shopPublicId: "shop_public_a",
      userId: "user-a",
    };

    const results = await Promise.allSettled([
      createCustomDomain({ ...base, hostname: "first.customer.com", requestId: "request-first" }),
      createCustomDomain({ ...base, hostname: "second.customer.com", requestId: "request-second" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "domain_limit_reached", status: 409 },
    });
    expect(Array.from(database.domains.values()).filter((row) => row.shopId === "shop-a" && row.type === "custom" && row.deletedAt === null)).toHaveLength(1);
    expect(database.auditActions.filter((action) => action === "domain.ownership_verified")).toHaveLength(1);
    expect(provider.creates).toBe(1);
  });

  it.each([
    ["missing", undefined],
    ["non-integer", 1.5],
    ["wrong type", "1"],
  ])("fails closed when the custom-domain plan limit is %s", async (_label, limit) => {
    const database = new DomainDatabase();
    if (limit === undefined) database.customDomainLimits.delete("shop-a");
    else database.customDomainLimits.set("shop-a", limit);
    const provider = new Provider();

    await expect(createCustomDomain({
      env: environment(database),
      hostname: "shop.customer.com",
      requestId: "request-invalid-limit",
      runtime: { dnsVerifier: activeDns, now: NOW, provider },
      shopPublicId: "shop_public_a",
      userId: "user-a",
    })).rejects.toMatchObject({
      code: "subscription_configuration_invalid",
      issues: ["custom_domain_limit_invalid"],
      status: 500,
    });
    expect(Array.from(database.domains.values()).filter((row) => row.type === "custom")).toHaveLength(0);
    expect(database.auditActions).not.toContain("domain.ownership_verified");
    expect(provider.creates).toBe(0);
  });

  it("creates one fresh verified domain when a deleted hostname is reclaimed concurrently", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const deleted: FakeDomain = {
      activatedAt: null, checkAttempts: 3, cloudflareHostnameId: null,
      createdAt: NOW.toISOString(), deleteRequestedAt: NOW.toISOString(), deletedAt: NOW.toISOString(),
      dnsStatus: "error", hostname: "shop.customer.com", hostnameStatus: "deleted", id: "dom-deleted",
      isPrimary: 0, lastCheckedAt: NOW.toISOString(), lastSafeErrorCode: null, leaseExpiresAt: null,
      leaseToken: null, nextCheckAt: null, shopId: "shop-a", sslStatus: "deleted", status: "deleted",
      type: "custom", updatedAt: NOW.toISOString(), validationMetadataJson: "{}", version: 7,
    };
    database.domains.set(deleted.id, deleted);
    const base = { env: environment(database), hostname: deleted.hostname, runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" };

    const [first, second] = await Promise.all([
      createCustomDomain({ ...base, requestId: "request-restore-a" }),
      createCustomDomain({ ...base, requestId: "request-restore-b" }),
    ]);

    expect(first.domain.id).toBe(second.domain.id);
    expect(first.domain.id).not.toBe(deleted.id);
    expect(database.domains.get(deleted.id)?.deletedAt).toBe(NOW.toISOString());
    expect(Array.from(database.domains.values()).filter((row) => row.hostname === deleted.hostname && row.deletedAt === null)).toHaveLength(1);
    expect(provider.creates).toBe(1);
  });

  it("does not restore a deleted hostname above the current plan limit", async () => {
    const database = new DomainDatabase();
    database.customDomainLimits.set("shop-a", 1);
    const provider = new Provider();
    await createCustomDomain({ env: environment(database), hostname: "live.customer.com", requestId: "request-live", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const deleted: FakeDomain = {
      activatedAt: null, checkAttempts: 1, cloudflareHostnameId: null,
      createdAt: NOW.toISOString(), deleteRequestedAt: NOW.toISOString(), deletedAt: NOW.toISOString(),
      dnsStatus: "error", hostname: "restore.customer.com", hostnameStatus: "deleted", id: "dom-restore-quota",
      isPrimary: 0, lastCheckedAt: NOW.toISOString(), lastSafeErrorCode: null, leaseExpiresAt: null,
      leaseToken: null, nextCheckAt: null, shopId: "shop-a", sslStatus: "deleted", status: "deleted",
      type: "custom", updatedAt: NOW.toISOString(), validationMetadataJson: "{}", version: 4,
    };
    database.domains.set(deleted.id, deleted);
    const restoreProvider = new Provider();

    await expect(createCustomDomain({ env: environment(database), hostname: deleted.hostname, requestId: "request-restore", runtime: { dnsVerifier: activeDns, now: NOW, provider: restoreProvider }, shopPublicId: "shop_public_a", userId: "user-a" }))
      .rejects.toMatchObject({ code: "domain_limit_reached", status: 409 });
    expect(database.domains.get(deleted.id)?.deletedAt).toBe(NOW.toISOString());
    expect(database.auditActions.filter((action) => action === "domain.restored")).toHaveLength(0);
    expect(restoreProvider.creates).toBe(0);
  });

  it("keeps a failed provider allocation charged against quota", async () => {
    const database = new DomainDatabase();
    database.customDomainLimits.set("shop-a", 1);
    const failingProvider = new Provider();
    failingProvider.createCustomHostname = () => {
      failingProvider.creates += 1;
      return Promise.reject(new Error("provider unavailable"));
    };
    failingProvider.findCustomHostname = () => Promise.resolve(null);

    const failed = await createCustomDomain({ env: environment(database), hostname: "failed.customer.com", requestId: "request-failed", runtime: { dnsVerifier: activeDns, now: NOW, provider: failingProvider }, shopPublicId: "shop_public_a", userId: "user-a" });
    expect(failed.created).toBe(true);
    expect(failed.domain.lastSafeErrorCode).toBe("provider_unavailable");

    const secondProvider = new Provider();
    await expect(createCustomDomain({ env: environment(database), hostname: "second.customer.com", requestId: "request-second", runtime: { dnsVerifier: activeDns, now: NOW, provider: secondProvider }, shopPublicId: "shop_public_a", userId: "user-a" }))
      .rejects.toMatchObject({ code: "domain_limit_reached", status: 409 });
    expect(database.auditActions.filter((action) => action === "domain.ownership_verified")).toHaveLength(1);
    expect(secondProvider.creates).toBe(0);
  });

  it("releases quota only after provider deletion completes", async () => {
    const database = new DomainDatabase();
    database.customDomainLimits.set("shop-a", 1);
    const env = environment(database);
    const createProvider = new Provider();
    const created = await createCustomDomain({ env, hostname: "old.customer.com", requestId: "request-old", runtime: { dnsVerifier: activeDns, now: NOW, provider: createProvider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const failingDeleteProvider = new Provider();
    failingDeleteProvider.deleteCustomHostname = () => {
      failingDeleteProvider.deletes += 1;
      return Promise.reject(new Error("provider unavailable"));
    };

    await expect(deleteCustomDomain({ domainId: created.domain.id, env, requestId: "request-delete-failed", runtime: { now: NOW, provider: failingDeleteProvider }, shopPublicId: "shop_public_a", userId: "user-a" }))
      .rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(database.domains.get(created.domain.id)?.deletedAt).toBeNull();

    const blockedProvider = new Provider();
    await expect(createCustomDomain({ env, hostname: "new.customer.com", requestId: "request-new-blocked", runtime: { dnsVerifier: activeDns, now: NOW, provider: blockedProvider }, shopPublicId: "shop_public_a", userId: "user-a" }))
      .rejects.toMatchObject({ code: "domain_limit_reached", status: 409 });
    expect(blockedProvider.creates).toBe(0);

    await deleteCustomDomain({ domainId: created.domain.id, env, requestId: "request-delete-retry", runtime: { now: NOW, provider: new Provider() }, shopPublicId: "shop_public_a", userId: "user-a" });
    const replacementProvider = new Provider();
    await expect(createCustomDomain({ env, hostname: "new.customer.com", requestId: "request-new", runtime: { dnsVerifier: activeDns, now: NOW, provider: replacementProvider }, shopPublicId: "shop_public_a", userId: "user-a" }))
      .resolves.toMatchObject({ created: true });
    expect(replacementProvider.creates).toBe(1);
  });

  it("returns one stable pending claim across concurrent same-shop replays", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const base = { env: environment(database), hostname: "shop.customer.com", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" };

    const [insertedResult, replayResult] = await Promise.all([
      createCustomDomainClaim({ ...base, requestId: "request-insert" }),
      createCustomDomainClaim({ ...base, requestId: "request-replay" }),
    ]);
    expect(insertedResult.domain.id).toBe(replayResult.domain.id);
    expect(insertedResult.domain.status).toBe("ownership_pending");
    expect(replayResult.domain.status).toBe("ownership_pending");
    expect(provider.creates).toBe(0);
  });

  it("allows different shops to hold tenant-bound pending claims for one hostname", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);

    const [first, second] = await Promise.all([
      createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" }),
      createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-b", runtime: { now: NOW, provider }, shopPublicId: "shop_public_b", userId: "user-b" }),
    ]);

    expect(first.domain.id).not.toBe(second.domain.id);
    expect(first.domain.dnsInstructions?.target).not.toBe(second.domain.dnsInstructions?.target);
    expect(first.domain.status).toBe("ownership_pending");
    expect(second.domain.status).toBe("ownership_pending");
    expect(provider.creates).toBe(0);
  });

  it("does not call Cloudflare when only the shared SaaS CNAME is present", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const claimed = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-claim", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });

    const checked = await checkCustomDomain({
      domainId: claimed.domain.id,
      env,
      requestId: "request-check",
      runtime: {
        dnsVerifier: activeDns,
        now: NOW,
        ownershipVerifier: () => Promise.resolve({ observedValues: [], status: "pending" }),
        provider,
      },
      shopPublicId: "shop_public_a",
      userId: "user-a",
    });

    expect(checked.status).toBe("ownership_pending");
    expect(checked.lastSafeErrorCode).toBe("domain_ownership_not_verified");
    expect(provider.creates).toBe(0);
  });

  it("does not replay one shop's TXT proof against another shop's claim", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const first = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const second = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-b", runtime: { now: NOW, provider }, shopPublicId: "shop_public_b", userId: "user-b" });
    const firstToken = first.domain.dnsInstructions?.target ?? "";

    const checked = await checkCustomDomain({
      domainId: second.domain.id,
      env,
      requestId: "request-replay",
      runtime: {
        now: NOW,
        ownershipVerifier: ({ expectedValue }) => Promise.resolve({
          observedValues: [firstToken],
          status: expectedValue === firstToken ? "active" : "pending",
        }),
        provider,
      },
      shopPublicId: "shop_public_b",
      userId: "user-b",
    });

    expect(checked.status).toBe("ownership_pending");
    expect(provider.creates).toBe(0);
  });

  it("expires an ownership claim without resolving DNS or calling Cloudflare", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const claimed = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-claim", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    let ownershipChecks = 0;
    const expiredAt = new Date(NOW.getTime() + 31 * 60_000);

    const checked = await checkCustomDomain({
      domainId: claimed.domain.id,
      env,
      requestId: "request-expired",
      runtime: {
        now: expiredAt,
        ownershipVerifier: () => {
          ownershipChecks += 1;
          return Promise.resolve({ observedValues: [], status: "active" });
        },
        provider,
      },
      shopPublicId: "shop_public_a",
      userId: "user-a",
    });

    expect(checked.status).toBe("ownership_expired");
    expect(checked.lastSafeErrorCode).toBe("domain_ownership_expired");
    expect(ownershipChecks).toBe(0);
    expect(provider.creates).toBe(0);
  });

  it("returns the promoted domain when an expiry update loses a concurrent promotion race", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const claimed = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-claim", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const expiredAt = new Date(NOW.getTime() + 31 * 60_000);
    database.beforeClaimExpiryUpdate = () => {
      const claim = database.claims.get(claimed.domain.id);
      if (claim === undefined) throw new Error("missing claim");
      const verifiedAt = expiredAt.toISOString();
      Object.assign(claim, { updatedAt: verifiedAt, verifiedAt, version: claim.version + 1 });
      database.domains.set("dom-promoted-race", {
        activatedAt: verifiedAt,
        checkAttempts: 0,
        cloudflareHostnameId: "cf-promoted-race",
        createdAt: verifiedAt,
        deleteRequestedAt: null,
        deletedAt: null,
        dnsStatus: "active",
        hostname: claim.hostname,
        hostnameStatus: "active",
        id: "dom-promoted-race",
        isPrimary: 0,
        lastCheckedAt: verifiedAt,
        lastSafeErrorCode: null,
        leaseExpiresAt: null,
        leaseToken: null,
        nextCheckAt: null,
        ownershipVerifiedAt: verifiedAt,
        shopId: claim.shopId,
        sslStatus: "active",
        status: "active",
        type: "custom",
        updatedAt: verifiedAt,
        validationMetadataJson: "{}",
        version: 1,
      });
    };

    const checked = await checkCustomDomain({
      domainId: claimed.domain.id,
      env,
      requestId: "request-expiry-race",
      runtime: { now: expiredAt, provider },
      shopPublicId: "shop_public_a",
      userId: "user-a",
    });

    expect(checked.id).toBe("dom-promoted-race");
    expect(checked.ownershipStatus).toBe("verified");
    expect(checked.status).toBe("active");
    expect(provider.creates).toBe(0);
  });

  it("does not promote a claim that expires while TXT ownership is being checked", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const database = new DomainDatabase();
      const provider = new Provider();
      const env = environment(database);
      const claimed = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-claim", runtime: { provider }, shopPublicId: "shop_public_a", userId: "user-a" });

      const checked = await checkCustomDomain({
        domainId: claimed.domain.id,
        env,
        requestId: "request-cross-expiry",
        runtime: {
          ownershipVerifier: ({ expectedValue }) => {
            vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
            return Promise.resolve({ observedValues: [expectedValue], status: "active" });
          },
          provider,
        },
        shopPublicId: "shop_public_a",
        userId: "user-a",
      });

      expect(checked.status).toBe("ownership_expired");
      expect(checked.lastSafeErrorCode).toBe("domain_ownership_expired");
      expect(provider.creates).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a verified-domain promotion cannot write its audit row", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const claimed = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-claim", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    database.failVerifiedClaimAudit = true;

    await expect(checkCustomDomain({
      domainId: claimed.domain.id,
      env,
      requestId: "request-audit-failure",
      runtime: {
        now: NOW,
        ownershipVerifier: ({ expectedValue }) => Promise.resolve({ observedValues: [expectedValue], status: "active" }),
        provider,
      },
      shopPublicId: "shop_public_a",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "domain_audit_failed", status: 500 });

    expect(database.auditActions).not.toContain("domain.ownership_verified");
    expect(provider.creates).toBe(0);
  });

  it("cancels a tenant-owned pending claim without calling Cloudflare", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const claimed = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-claim", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });

    await expect(deleteCustomDomain({
      domainId: claimed.domain.id,
      env,
      requestId: "request-delete-claim",
      runtime: { now: NOW, provider },
      shopPublicId: "shop_public_a",
      userId: "user-a",
    })).resolves.toBeUndefined();
    expect(database.claims.has(claimed.domain.id)).toBe(false);
    expect(provider.deletes).toBe(0);
  });

  it("allows only one tenant to promote simultaneous valid claims", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const first = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const second = await createCustomDomainClaim({ env, hostname: "shop.customer.com", requestId: "request-b", runtime: { now: NOW, provider }, shopPublicId: "shop_public_b", userId: "user-b" });
    const ownershipVerifier = ({ expectedValue }: { expectedValue: string }) => Promise.resolve({ observedValues: [expectedValue], status: "active" as const });

    const results = await Promise.allSettled([
      checkCustomDomain({ domainId: first.domain.id, env, requestId: "request-check-a", runtime: { dnsVerifier: activeDns, now: NOW, ownershipVerifier, provider }, shopPublicId: "shop_public_a", userId: "user-a" }),
      checkCustomDomain({ domainId: second.domain.id, env, requestId: "request-check-b", runtime: { dnsVerifier: activeDns, now: NOW, ownershipVerifier, provider }, shopPublicId: "shop_public_b", userId: "user-b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "domain_already_claimed", status: 409 } });
    expect(provider.creates).toBe(1);
  });

  it("blocks a duplicate hostname claim across tenants", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    await createCustomDomain({ env: environment(database), hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    await expect(createCustomDomain({ env: environment(database), hostname: "shop.customer.com", requestId: "request-b", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_b", userId: "user-b" })).rejects.toMatchObject({ code: "domain_already_claimed", status: 409 });
  });

  it("does not activate until provider hostname, SSL and DNS are active", async () => {
    const database = new DomainDatabase();
    const provider = new Provider("active", "pending_validation");
    const created = await createCustomDomain({ env: environment(database), hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    expect(created.domain.status).toBe("validating");
    provider.nextSslStatus = "active";
    const checked = await checkCustomDomain({ domainId: created.domain.id, env: environment(database), requestId: "request-check", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    expect(checked.status).toBe("active");
  });

  it("atomically falls back from a primary custom domain when provider readiness becomes pending", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    await setPrimaryDomain({ domainId: created.domain.id, env, requestId: "request-primary", shopPublicId: "shop_public_a", userId: "user-a" });
    provider.nextSslStatus = "pending_validation";

    const checked = await checkCustomDomain({ domainId: created.domain.id, env, requestId: "request-check", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    expect(checked.status).toBe("validating");
    expect(checked.isPrimary).toBe(false);
    expect(database.domains.get("dom_platform_shop-a")?.isPrimary).toBe(1);
    expect(database.canonical.get("shop-a")).toBe("dom_platform_shop-a");
  });

  it("fails closed on a provider hostname identity conflict", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    provider.createCustomHostname = () => Promise.resolve({ hostname: "other.customer.com", id: "cf-conflict", ssl: { status: "active" }, status: "active" });
    const created = await createCustomDomain({ env: environment(database), hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    expect(created.domain.status).toBe("failed");
    expect(created.domain.lastSafeErrorCode).toBe("domain_provider_conflict");
  });

  it("switches both primary flags and canonical domain atomically", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const primary = await setPrimaryDomain({ domainId: created.domain.id, env, requestId: "request-primary", shopPublicId: "shop_public_a", userId: "user-a" });
    expect(primary.isPrimary).toBe(true);
    expect(primary.version).toBeGreaterThan(created.domain.version);
    expect(database.domains.get("dom_platform_shop-a")?.isPrimary).toBe(0);
    expect(database.canonical.get("shop-a")).toBe(created.domain.id);
  });

  it("does not let a downgraded shop make a custom domain primary", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    database.customDomainFeature.set("shop-a", false);
    await expect(setPrimaryDomain({ domainId: created.domain.id, env, requestId: "request-primary", shopPublicId: "shop_public_a", userId: "user-a" })).rejects.toMatchObject({ code: "subscription_required", status: 402 });
    expect(database.domains.get(created.domain.id)?.isPrimary).toBe(0);
    expect(database.canonical.get("shop-a")).toBe("dom_platform_shop-a");
  });

  it("blocks deletion while a live payment attempt references the domain", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    database.activePaymentDomainId = created.domain.id;
    const version = database.domains.get(created.domain.id)?.version;
    await expect(deleteCustomDomain({ domainId: created.domain.id, env, requestId: "request-delete", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" })).rejects.toMatchObject({ code: "domain_in_use", issues: ["active_payment_attempt"] });
    expect(database.domains.get(created.domain.id)?.version).toBe(version);
    expect(provider.deletes).toBe(0);
  });

  it("refuses deletion when a payment becomes active inside the guarded routing transition", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const primary = await setPrimaryDomain({ domainId: created.domain.id, env, requestId: "request-primary", shopPublicId: "shop_public_a", userId: "user-a" });
    database.beforeDeleteRequest = () => { database.activePaymentDomainId = created.domain.id; };

    await expect(deleteCustomDomain({ domainId: created.domain.id, env, requestId: "request-delete", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" })).rejects.toMatchObject({ code: "domain_in_use", issues: ["active_payment_attempt"] });
    const current = database.domains.get(created.domain.id);
    expect(current?.deleteRequestedAt).toBeNull();
    expect(current?.isPrimary).toBe(1);
    expect(current?.version).toBe(primary.version);
    expect(database.canonical.get("shop-a")).toBe(created.domain.id);
    expect(provider.deletes).toBe(0);
  });

  it("does not promote a domain deleted after the primary preflight read", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    database.beforePrimaryGuard = () => {
      const row = database.domains.get(created.domain.id);
      if (row !== undefined) Object.assign(row, { deleteRequestedAt: NOW.toISOString(), status: "suspended", version: row.version + 1 });
    };

    await expect(setPrimaryDomain({ domainId: created.domain.id, env, requestId: "request-primary", shopPublicId: "shop_public_a", userId: "user-a" })).rejects.toMatchObject({ code: "domain_not_ready", status: 409 });
    expect(database.domains.get(created.domain.id)?.isPrimary).toBe(0);
    expect(database.domains.get("dom_platform_shop-a")?.isPrimary).toBe(1);
    expect(database.canonical.get("shop-a")).toBe("dom_platform_shop-a");
  });

  it("removes routing before provider deletion and keeps repeated delete idempotent", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const primary = await setPrimaryDomain({ domainId: created.domain.id, env, requestId: "request-primary", shopPublicId: "shop_public_a", userId: "user-a" });
    database.customDomainFeature.set("shop-a", false);
    await deleteCustomDomain({ domainId: created.domain.id, env, requestId: "request-delete", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    await deleteCustomDomain({ domainId: created.domain.id, env, requestId: "request-delete-retry", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const deleted = database.domains.get(created.domain.id);
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.version).toBeGreaterThan(primary.version);
    expect(database.domains.get("dom_platform_shop-a")?.isPrimary).toBe(1);
    expect(database.canonical.get("shop-a")).toBe("dom_platform_shop-a");
    expect(provider.deletes).toBe(1);
  });

  it("claims due reconciliation work with a lease and clears it after polling", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    const before = database.domains.get(created.domain.id)?.checkAttempts ?? 0;
    const future = new Date(NOW.getTime() + 7 * 60 * 60_000);
    await expect(reconcileCustomDomains(env, future, { dnsVerifier: activeDns, provider })).resolves.toEqual({ checked: 1, deleted: 0, failed: 0 });
    const reconciled = database.domains.get(created.domain.id);
    expect(reconciled?.checkAttempts).toBe(before + 1);
    expect(reconciled?.leaseToken).toBeNull();
    expect(reconciled?.leaseExpiresAt).toBeNull();
  });

  it("suspends routing immediately and defers provider deletion while a poll owns the lease", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    await setPrimaryDomain({ domainId: created.domain.id, env, requestId: "request-primary", shopPublicId: "shop_public_a", userId: "user-a" });

    let enterProvider: (() => void) | undefined;
    let releaseProvider: (() => void) | undefined;
    const providerEntered = new Promise<void>((resolve) => { enterProvider = resolve; });
    const providerReleased = new Promise<void>((resolve) => { releaseProvider = resolve; });
    provider.getCustomHostname = async () => {
      enterProvider?.();
      await providerReleased;
      if (provider.current === null) throw new Error("missing");
      return provider.current;
    };

    const polling = checkCustomDomain({ domainId: created.domain.id, env, requestId: "request-check", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" }).catch((error: unknown) => error);
    await providerEntered;
    await deleteCustomDomain({ domainId: created.domain.id, env, requestId: "request-delete", runtime: { now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });

    const suspended = database.domains.get(created.domain.id);
    expect(suspended?.status).toBe("suspended");
    expect(suspended?.deleteRequestedAt).toBe(NOW.toISOString());
    expect(suspended?.leaseToken).not.toBeNull();
    expect(database.domains.get("dom_platform_shop-a")?.isPrimary).toBe(1);
    expect(database.canonical.get("shop-a")).toBe("dom_platform_shop-a");
    expect(provider.deletes).toBe(0);

    releaseProvider?.();
    await expect(polling).resolves.toMatchObject({ code: "domain_lease_lost", status: 409 });
    const afterPoll = database.domains.get(created.domain.id);
    expect(afterPoll?.status).toBe("suspended");
    expect(afterPoll?.deleteRequestedAt).toBe(NOW.toISOString());

    const afterLeaseExpiry = new Date(NOW.getTime() + 2 * 60_000);
    await expect(reconcileCustomDomains(env, afterLeaseExpiry, { dnsVerifier: activeDns, provider })).resolves.toEqual({ checked: 0, deleted: 1, failed: 0 });
    expect(database.domains.get(created.domain.id)?.status).toBe("deleted");
    expect(provider.deletes).toBe(1);
  });

  it("counts a persisted provider polling failure as failed reconciliation", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    provider.getCustomHostname = () => Promise.reject(new Error("provider timeout"));

    const future = new Date(NOW.getTime() + 7 * 60 * 60_000);
    await expect(reconcileCustomDomains(env, future, { dnsVerifier: activeDns, provider })).resolves.toEqual({ checked: 0, deleted: 0, failed: 1 });
    const failed = database.domains.get(created.domain.id);
    expect(failed?.lastSafeErrorCode).toBe("provider_unavailable");
    expect(failed?.leaseToken).toBeNull();
  });

  it("atomically falls back from a primary custom domain on reconciliation provider failure", async () => {
    const database = new DomainDatabase();
    const provider = new Provider();
    const env = environment(database);
    const created = await createCustomDomain({ env, hostname: "shop.customer.com", requestId: "request-a", runtime: { dnsVerifier: activeDns, now: NOW, provider }, shopPublicId: "shop_public_a", userId: "user-a" });
    await setPrimaryDomain({ domainId: created.domain.id, env, requestId: "request-primary", shopPublicId: "shop_public_a", userId: "user-a" });
    provider.getCustomHostname = () => Promise.reject(new Error("provider timeout"));

    const future = new Date(NOW.getTime() + 7 * 60 * 60_000);
    await expect(reconcileCustomDomains(env, future, { dnsVerifier: activeDns, provider })).resolves.toEqual({ checked: 0, deleted: 0, failed: 1 });
    const failed = database.domains.get(created.domain.id);
    expect(failed?.status).toBe("validating");
    expect(failed?.isPrimary).toBe(0);
    expect(database.domains.get("dom_platform_shop-a")?.isPrimary).toBe(1);
    expect(database.canonical.get("shop-a")).toBe("dom_platform_shop-a");
  });

  it("uses bounded exponential backoff and slower active polling", () => {
    expect(customDomainBackoffSeconds(0, "validating")).toBe(30);
    expect(customDomainBackoffSeconds(20, "validating")).toBe(3_600);
    expect(customDomainBackoffSeconds(2, "active")).toBe(21_600);
    expect(customDomainBackoffSeconds(2, "failed")).toBe(86_400);
  });
});
