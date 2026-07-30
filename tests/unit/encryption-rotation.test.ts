import { describe, expect, it } from "vitest";

import {
  decryptGeneratedLicenseArtifact,
  decryptGeneratedLicenseProviderSecrets,
  encryptGeneratedLicenseArtifact,
  encryptGeneratedLicenseProviderSecrets,
} from "../../src/lib/commerce/generated-license-crypto";
import { decryptInventoryKey, encryptInventoryKey } from "../../src/lib/crypto/inventory";
import { createEncryptionRotation, processEncryptionRotation, type RotationKeyFamily } from "../../src/lib/operations/rotation";
import { decryptPayOSCredentials, encryptPayOSCredentials, type PayOSCredentials } from "../../src/lib/payments/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { decryptTelegramChatId, decryptTelegramCredential, encryptTelegramChatId, encryptTelegramCredential } from "../../src/lib/telegram/crypto";

const KEK_V1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEK_V2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const NOW = new Date("2026-07-26T00:00:00.000Z");

type ResourceType =
  | "generated_license_artifact"
  | "generated_license_credential"
  | "inventory_key"
  | "payment_credential"
  | "telegram_credential"
  | "telegram_recipient";

type InventoryRow = {
  ciphertextB64: string;
  id: string;
  ivB64: string;
  keyVersion: string;
  shopId: string;
  variantId: string;
};

type PaymentRow = Awaited<ReturnType<typeof encryptPayOSCredentials>> & {
  id: string;
  integrationId: string;
  keyVersion: string;
  shopId: string;
};

type TelegramCredentialRow = Awaited<ReturnType<typeof encryptTelegramCredential>> & {
  id: string;
  integrationId: string;
  keyVersion: string;
  shopId: string;
};

type TelegramRecipientRow = {
  ciphertextB64: string;
  id: string;
  identityId: string;
  integrationId: string;
  ivB64: string;
  keyVersion: string;
  shopId: string;
};

type GeneratedLicenseCredentialRow = Awaited<ReturnType<typeof encryptGeneratedLicenseProviderSecrets>> & {
  connectionId: string;
  id: string;
  shopId: string;
  status: "active";
  version: number;
};

type GeneratedLicenseArtifactRow = Awaited<ReturnType<typeof encryptGeneratedLicenseArtifact>> & {
  artifactId: string;
  id: string;
  requestId: string;
  shopId: string;
  status: "active";
};

type RunRow = {
  dryRun: number;
  failedItems: number;
  id: string;
  keyFamily: RotationKeyFamily;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  processedItems: number;
  requestId: string;
  requestedByUserId: string | null;
  shopId: string | null;
  sourceKeyVersion: string;
  status: string;
  targetKeyVersion: string;
  totalItems: number;
};

type ItemRow = {
  attempts: number;
  id: string;
  lastSafeErrorCode: string | null;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  resourceId: string;
  resourceType: ResourceType;
  runId: string;
  shopId: string;
  status: string;
};

type AuditRow = {
  action: string;
  metadata: string;
  resourceId: string;
};

type RotationSeed = {
  generatedLicenseArtifacts?: Array<{ format: "json" | "text"; plaintext: string }>;
  generatedLicenseCredentials?: Array<{ credential: string; endpoint: string }>;
  inventory?: string[];
  paymentCredentials?: PayOSCredentials[];
  telegramCredentials?: Array<{ botToken: string; webhookSecret: string }>;
  telegramRecipients?: string[];
};

const ACTIVE_STATUSES = new Set(["planned", "running", "paused"]);

async function rotationEnvironment(seedInput: string[] | RotationSeed) {
  const seed = Array.isArray(seedInput) ? { inventory: seedInput } : seedInput;
  const inventory = new Map<string, InventoryRow>();
  const generatedLicenseArtifacts = new Map<string, GeneratedLicenseArtifactRow>();
  const generatedLicenseCredentials = new Map<string, GeneratedLicenseCredentialRow>();
  const paymentCredentials = new Map<string, PaymentRow>();
  const telegramCredentials = new Map<string, TelegramCredentialRow>();
  const telegramRecipients = new Map<string, TelegramRecipientRow>();

  for (const [index, value] of (seed.inventory ?? []).entries()) {
    const variantId = `variant-${String(index)}`;
    const encrypted = await encryptInventoryKey({ hmacSecret: "identifier-secret", keyVersion: "v1", kek: KEK_V1, plaintext: value, shopId: "shop-a", variantId });
    inventory.set(`key-${String(index)}`, { ...encrypted, id: `key-${String(index)}`, shopId: "shop-a", variantId });
  }
  for (const [index, value] of (seed.generatedLicenseCredentials ?? []).entries()) {
    const id = `generated-license-credential-${String(index)}`;
    const connectionId = `generated-license-connection-${String(index)}`;
    const encrypted = await encryptGeneratedLicenseProviderSecrets({
      ...value,
      connectionId,
      credentialId: id,
      hmacSecret: "identifier-secret",
      kek: KEK_V1,
      keyVersion: "v1",
      shopId: "shop-a",
    });
    generatedLicenseCredentials.set(id, { ...encrypted, connectionId, id, shopId: "shop-a", status: "active", version: 1 });
  }
  for (const [index, value] of (seed.generatedLicenseArtifacts ?? []).entries()) {
    const artifactId = `generated-license-artifact-${String(index)}`;
    const requestId = `generated-license-request-${String(index)}`;
    const encrypted = await encryptGeneratedLicenseArtifact({
      ...value,
      artifactId,
      hmacSecret: "identifier-secret",
      kek: KEK_V1,
      keyVersion: "v1",
      requestId,
      shopId: "shop-a",
    });
    generatedLicenseArtifacts.set(artifactId, { ...encrypted, artifactId, id: artifactId, requestId, shopId: "shop-a", status: "active" });
  }
  for (const [index, value] of (seed.paymentCredentials ?? []).entries()) {
    const id = `payment-${String(index)}`;
    const integrationId = `payment-integration-${String(index)}`;
    const encrypted = await encryptPayOSCredentials(value, { credentialId: id, hmacSecret: "identifier-secret", integrationId, kek: KEK_V1, keyVersion: "v1", shopId: "shop-a" });
    paymentCredentials.set(id, { ...encrypted, id, integrationId, keyVersion: "v1", shopId: "shop-a" });
  }
  for (const [index, value] of (seed.telegramCredentials ?? []).entries()) {
    const id = `telegram-credential-${String(index)}`;
    const integrationId = `telegram-integration-${String(index)}`;
    const encrypted = await encryptTelegramCredential({ ...value, credentialId: id, hmacSecret: "identifier-secret", integrationId, kek: KEK_V1, keyVersion: "v1", shopId: "shop-a" });
    telegramCredentials.set(id, { ...encrypted, id, integrationId, keyVersion: "v1", shopId: "shop-a" });
  }
  for (const [index, chatId] of (seed.telegramRecipients ?? []).entries()) {
    const id = `telegram-recipient-${String(index)}`;
    const identityId = `telegram-identity-${String(index)}`;
    const integrationId = `telegram-recipient-integration-${String(index)}`;
    const encrypted = await encryptTelegramChatId({ chatId, hmacSecret: "identifier-secret", identityId, integrationId, kek: KEK_V1, keyVersion: "v1", shopId: "shop-a" });
    telegramRecipients.set(id, { ...encrypted, id, identityId, integrationId, keyVersion: "v1", shopId: "shop-a" });
  }

  const runs = new Map<string, RunRow>();
  const items = new Map<string, ItemRow>();
  const audits: AuditRow[] = [];
  let failGeneratedResourceWrites = 0;
  let resourceWrites = 0;
  let stealItemLeaseOnResourceUpdate = false;

  function resourceMap(sql: string): Map<string, { id: string; keyVersion: string; shopId: string }> | null {
    if (sql.includes("generated_license_provider_credentials")) return generatedLicenseCredentials;
    if (sql.includes("generated_license_artifacts")) return generatedLicenseArtifacts;
    if (sql.includes("inventory_keys")) return inventory;
    if (sql.includes("payment_credentials")) return paymentCredentials;
    if (sql.includes("telegram_credentials")) return telegramCredentials;
    if (sql.includes("telegram_recipients")) return telegramRecipients;
    return null;
  }

  function hasOverlap(keyFamily: RotationKeyFamily, shopId: string | null, excludedRunId: string | null = null): boolean {
    return Array.from(runs.values()).some((run) => run.id !== excludedRunId
      && run.keyFamily === keyFamily
      && ACTIVE_STATUSES.has(run.status)
      && (run.shopId === null || shopId === null || run.shopId === shopId));
  }

  function currentResource(item: ItemRow): { id: string; keyVersion: string; shopId: string } | undefined {
    if (item.resourceType === "generated_license_credential") return generatedLicenseCredentials.get(item.resourceId);
    if (item.resourceType === "generated_license_artifact") return generatedLicenseArtifacts.get(item.resourceId);
    if (item.resourceType === "inventory_key") return inventory.get(item.resourceId);
    if (item.resourceType === "payment_credential") return paymentCredentials.get(item.resourceId);
    if (item.resourceType === "telegram_credential") return telegramCredentials.get(item.resourceId);
    return telegramRecipients.get(item.resourceId);
  }

  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all() {
              if (sql.includes(" AS resource") && sql.includes("NOT EXISTS")) {
                const resources = resourceMap(sql);
                if (resources === null) return Promise.resolve({ results: [] });
                const source = String(values[0]);
                const shopId = typeof values[1] === "string" ? values[1] : null;
                const runId = String(values[3]);
                const rows = Array.from(resources.values()).filter((row) => row.keyVersion === source
                  && (shopId === null || row.shopId === shopId)
                  && !Array.from(items.values()).some((item) => item.runId === runId && item.resourceId === row.id));
                return Promise.resolve({ results: rows.slice(0, 100).map((row) => ({ id: row.id, shopId: row.shopId })) });
              }
              return Promise.resolve({ results: [] });
            },
            first() {
              if (sql.includes("SELECT id FROM encryption_rotation_runs") && sql.includes("id != ?")) {
                const excludedRunId = String(values[0]);
                const keyFamily = String(values[1]) as RotationKeyFamily;
                const shopId = typeof values[2] === "string" ? values[2] : null;
                const overlap = Array.from(runs.values()).find((run) => run.id !== excludedRunId
                  && run.keyFamily === keyFamily
                  && ACTIVE_STATUSES.has(run.status)
                  && (run.shopId === null || shopId === null || run.shopId === shopId));
                return Promise.resolve(overlap === undefined ? null : { id: overlap.id });
              }
              if (sql.includes("COUNT(*) AS count")) {
                const resources = resourceMap(sql);
                if (resources === null) return Promise.resolve({ count: 0 });
                const source = String(values[0]);
                const shopId = typeof values[1] === "string" ? values[1] : null;
                return Promise.resolve({ count: Array.from(resources.values()).filter((row) => row.keyVersion === source && (shopId === null || row.shopId === shopId)).length });
              }
              if (sql.includes("FROM encryption_rotation_runs") && sql.includes("WHERE id = ?")) return Promise.resolve(runs.get(String(values[0])) ?? null);
              if (sql.includes("FROM encryption_rotation_items") && sql.includes("status = 'pending'")) {
                const item = Array.from(items.values()).find((candidate) => candidate.runId === values[0]
                  && candidate.status === "pending"
                  && (candidate.leaseToken === null || candidate.leaseExpiresAt === null || candidate.leaseExpiresAt <= String(values[1])));
                return Promise.resolve(item ?? null);
              }
              if (sql.includes("FROM generated_license_provider_credentials") && sql.includes("WHERE id = ?")) return Promise.resolve(generatedLicenseCredentials.get(String(values[0])) ?? null);
              if (sql.includes("FROM generated_license_artifacts") && sql.includes("WHERE id = ?")) return Promise.resolve(generatedLicenseArtifacts.get(String(values[0])) ?? null);
              if (sql.includes("FROM inventory_keys WHERE id = ?")) return Promise.resolve(inventory.get(String(values[0])) ?? null);
              if (sql.includes("FROM payment_credentials WHERE id = ?")) return Promise.resolve(paymentCredentials.get(String(values[0])) ?? null);
              if (sql.includes("FROM telegram_credentials WHERE id = ?")) return Promise.resolve(telegramCredentials.get(String(values[0])) ?? null);
              if (sql.includes("FROM telegram_recipients WHERE id = ?")) return Promise.resolve(telegramRecipients.get(String(values[0])) ?? null);
              if (sql.includes("COUNT(*) AS totalItems")) {
                const rows = Array.from(items.values()).filter((item) => item.runId === values[0]);
                return Promise.resolve({ failedItems: rows.filter((item) => item.status === "failed" || item.status === "manual_review").length, processedItems: rows.filter((item) => item.status === "completed" || item.status === "skipped").length, totalItems: rows.length });
              }
              return Promise.resolve(null);
            },
            run() {
              if (sql.includes("INSERT INTO encryption_rotation_runs")) {
                const dryRun = Number(values[7]);
                const keyFamily = String(values[3]) as RotationKeyFamily;
                const shopId = typeof values[1] === "string" ? values[1] : null;
                if (dryRun === 0 && hasOverlap(keyFamily, shopId)) return Promise.resolve({ meta: { changes: 0 } });
                runs.set(String(values[0]), {
                  dryRun,
                  failedItems: 0,
                  id: String(values[0]),
                  keyFamily,
                  leaseExpiresAt: null,
                  leaseToken: null,
                  processedItems: 0,
                  requestId: String(values[10]),
                  requestedByUserId: typeof values[9] === "string" ? values[9] : null,
                  shopId,
                  sourceKeyVersion: String(values[4]),
                  status: String(values[6]),
                  targetKeyVersion: String(values[5]),
                  totalItems: Number(values[8]),
                });
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("INSERT INTO audit_logs")) {
                const action = String(values[4]);
                const resourceId = String(values[5]);
                if (!runs.has(resourceId) || audits.some((audit) => audit.action === action && audit.resourceId === resourceId)) return Promise.resolve({ meta: { changes: 0 } });
                audits.push({ action, metadata: String(values[6]), resourceId });
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("status IN ('completed', 'skipped')")) {
                const runId = String(values[1]);
                const resourceType = String(values[2]);
                const source = String(values[3]);
                const shopId = typeof values[4] === "string" ? values[4] : null;
                let changes = 0;
                for (const item of items.values()) {
                  const resource = currentResource(item);
                  if (item.runId === runId && item.resourceType === resourceType && (item.status === "completed" || item.status === "skipped")
                    && resource?.keyVersion === source && (shopId === null || resource.shopId === shopId)) {
                    Object.assign(item, { leaseExpiresAt: null, leaseToken: null, status: "pending" });
                    changes += 1;
                  }
                }
                return Promise.resolve({ meta: { changes } });
              }
              if (sql.includes("INSERT OR IGNORE INTO encryption_rotation_items")) {
                if (!Array.from(items.values()).some((item) => item.runId === values[1] && item.resourceId === values[4])) {
                  items.set(String(values[0]), { attempts: 0, id: String(values[0]), lastSafeErrorCode: null, leaseExpiresAt: null, leaseToken: null, resourceId: String(values[4]), resourceType: String(values[3]) as ResourceType, runId: String(values[1]), shopId: String(values[2]), status: "pending" });
                }
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("SET status = 'planned', completed_at = NULL")) {
                const run = runs.get(String(values[1]));
                if (run === undefined || run.status !== "completed" || hasOverlap(run.keyFamily, run.shopId, run.id)) return Promise.resolve({ meta: { changes: 0 } });
                run.status = "planned";
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("SET status = 'running', lease_token")) {
                const run = runs.get(String(values[4]));
                if (run === undefined || run.dryRun !== 0 || !["planned", "running", "paused", "failed"].includes(run.status)
                  || (run.leaseToken !== null && run.leaseExpiresAt !== null && run.leaseExpiresAt > String(values[5]))) return Promise.resolve({ meta: { changes: 0 } });
                Object.assign(run, { leaseExpiresAt: values[1], leaseToken: values[0], status: "running" });
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("SET status = 'pending', lease_token = NULL") && sql.includes("status = 'failed'")) {
                for (const item of items.values()) {
                  if (item.runId === values[1] && (item.status === "failed" || (item.status === "processing" && item.leaseExpiresAt !== null && item.leaseExpiresAt <= String(values[2])))) Object.assign(item, { leaseExpiresAt: null, leaseToken: null, status: "pending" });
                }
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("SET status = 'processing', attempts")) {
                const item = items.get(String(values[3]));
                const run = runs.get(String(values[6]));
                if (item === undefined || run === undefined || item.runId !== values[4] || item.status !== "pending" || run.leaseToken !== values[7] || run.status !== "running") return Promise.resolve({ meta: { changes: 0 } });
                Object.assign(item, { attempts: item.attempts + 1, lastSafeErrorCode: null, leaseExpiresAt: values[1], leaseToken: values[0], status: "processing" });
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("UPDATE generated_license_provider_credentials")) {
                const row = generatedLicenseCredentials.get(String(values[8]));
                const item = items.get(String(values[11]));
                if (stealItemLeaseOnResourceUpdate && item !== undefined) item.leaseToken = "stolen-lease";
                if (row === undefined || item === undefined || row.shopId !== values[9] || row.keyVersion !== values[10] || item.leaseToken !== values[12] || item.status !== "processing") return Promise.resolve({ meta: { changes: 0 } });
                if (failGeneratedResourceWrites > 0) {
                  failGeneratedResourceWrites -= 1;
                  return Promise.resolve({ meta: { changes: 0 } });
                }
                Object.assign(row, {
                  credentialCiphertextB64: values[3],
                  credentialFingerprint: values[6],
                  credentialIvB64: values[4],
                  endpointCiphertextB64: values[1],
                  endpointFingerprint: values[5],
                  endpointIvB64: values[2],
                  keyVersion: values[0],
                  version: row.version + 1,
                });
                resourceWrites += 1;
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("UPDATE generated_license_artifacts")) {
                const row = generatedLicenseArtifacts.get(String(values[4]));
                const item = items.get(String(values[7]));
                if (stealItemLeaseOnResourceUpdate && item !== undefined) item.leaseToken = "stolen-lease";
                if (row === undefined || item === undefined || row.shopId !== values[5] || row.keyVersion !== values[6] || item.leaseToken !== values[8] || item.status !== "processing") return Promise.resolve({ meta: { changes: 0 } });
                if (failGeneratedResourceWrites > 0) {
                  failGeneratedResourceWrites -= 1;
                  return Promise.resolve({ meta: { changes: 0 } });
                }
                Object.assign(row, { artifactFingerprint: values[3], ciphertextB64: values[0], ivB64: values[1], keyVersion: values[2] });
                resourceWrites += 1;
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("UPDATE inventory_keys SET ciphertext_b64")) {
                const row = inventory.get(String(values[3]));
                const item = items.get(String(values[6]));
                if (stealItemLeaseOnResourceUpdate && item !== undefined) item.leaseToken = "stolen-lease";
                if (row === undefined || item === undefined || row.shopId !== values[4] || row.keyVersion !== values[5] || item.leaseToken !== values[7] || item.status !== "processing") return Promise.resolve({ meta: { changes: 0 } });
                Object.assign(row, { ciphertextB64: values[0], ivB64: values[1], keyVersion: values[2] });
                resourceWrites += 1;
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("UPDATE payment_credentials SET key_version")) {
                const row = paymentCredentials.get(String(values[7]));
                const item = items.get(String(values[10]));
                if (row === undefined || item === undefined || row.shopId !== values[8] || row.keyVersion !== values[9] || item.leaseToken !== values[11] || item.status !== "processing") return Promise.resolve({ meta: { changes: 0 } });
                Object.assign(row, { keyVersion: values[0], clientIdCiphertextB64: values[1], clientIdIvB64: values[2], apiKeyCiphertextB64: values[3], apiKeyIvB64: values[4], checksumKeyCiphertextB64: values[5], checksumKeyIvB64: values[6] });
                resourceWrites += 1;
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("UPDATE telegram_credentials SET key_version")) {
                const row = telegramCredentials.get(String(values[5]));
                const item = items.get(String(values[8]));
                if (row === undefined || item === undefined || row.shopId !== values[6] || row.keyVersion !== values[7] || item.leaseToken !== values[9] || item.status !== "processing") return Promise.resolve({ meta: { changes: 0 } });
                Object.assign(row, { keyVersion: values[0], botTokenCiphertextB64: values[1], botTokenIvB64: values[2], webhookSecretCiphertextB64: values[3], webhookSecretIvB64: values[4] });
                resourceWrites += 1;
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("UPDATE telegram_recipients SET key_version")) {
                const row = telegramRecipients.get(String(values[3]));
                const item = items.get(String(values[6]));
                if (row === undefined || item === undefined || row.shopId !== values[4] || row.keyVersion !== values[5] || item.leaseToken !== values[7] || item.status !== "processing") return Promise.resolve({ meta: { changes: 0 } });
                Object.assign(row, { keyVersion: values[0], ciphertextB64: values[1], ivB64: values[2] });
                resourceWrites += 1;
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("SET status = ?, last_safe_error_code")) {
                const item = items.get(String(values[4]));
                if (item === undefined || item.leaseToken !== values[5] || item.status !== "processing") return Promise.resolve({ meta: { changes: 0 } });
                Object.assign(item, { lastSafeErrorCode: values[1], leaseExpiresAt: null, leaseToken: null, status: values[0] });
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("SET status = ?, total_items")) {
                const run = runs.get(String(values[7]));
                if (run === undefined || run.leaseToken !== values[8] || run.status !== "running") return Promise.resolve({ meta: { changes: 0 } });
                Object.assign(run, { failedItems: values[3], leaseExpiresAt: null, leaseToken: null, processedItems: values[2], status: values[0], totalItems: values[1] });
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("dry_run = 1")) {
                const run = runs.get(String(values[3]));
                if (run !== undefined && run.status !== "canceled") Object.assign(run, { status: "completed", totalItems: values[0] });
                return Promise.resolve({ meta: { changes: run === undefined ? 0 : 1 } });
              }
              return Promise.resolve({ meta: { changes: 1 } });
            },
          };
        },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  const env = {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v2",
    ACTIVE_INVENTORY_KEY_VERSION: "v2",
    CREDENTIAL_KEK_V1: KEK_V1,
    CREDENTIAL_KEK_V2: KEK_V2,
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
    INVENTORY_KEK_V1: KEK_V1,
    INVENTORY_KEK_V2: KEK_V2,
    PLATFORM_DB: database,
  } as unknown as AppBindings;
  return {
    env,
    getAudits: () => audits,
    getGeneratedLicenseArtifacts: () => generatedLicenseArtifacts,
    getGeneratedLicenseCredentials: () => generatedLicenseCredentials,
    getInventory: () => inventory,
    getItems: () => items,
    getPaymentCredentials: () => paymentCredentials,
    getResourceWrites: () => resourceWrites,
    getRuns: () => runs,
    getTelegramCredentials: () => telegramCredentials,
    getTelegramRecipients: () => telegramRecipients,
    setGeneratedResourceWriteFailures: (value: number) => { failGeneratedResourceWrites = value; },
    setStealItemLease: (value: boolean) => { stealItemLeaseOnResourceUpdate = value; },
  };
}

describe("resumable encryption rotation", () => {
  it("dry-run counts source rows without creating items or rewriting ciphertext", async () => {
    const runtime = await rotationEnvironment(["KEY-A", "KEY-B"]);
    const before = JSON.stringify(Array.from(runtime.getInventory().values()));
    const result = await createEncryptionRotation({ dryRun: true, env: runtime.env, keyFamily: "inventory", requestId: "request-dry-run", shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" });
    expect(result).toMatchObject({ completed: true, oldVersionRows: 2, totalItems: 2 });
    expect(runtime.getItems().size).toBe(0);
    expect(runtime.getResourceWrites()).toBe(0);
    expect(JSON.stringify(Array.from(runtime.getInventory().values()))).toBe(before);
  });

  it("requires the target version to be active for live rotation", async () => {
    const runtime = await rotationEnvironment(["KEY-A"]);
    runtime.env.ACTIVE_INVENTORY_KEY_VERSION = "v1";
    await expect(createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-inactive-target", shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" })).rejects.toMatchObject({ code: "rotation_target_not_active" });
  });

  it("resumes in bounded batches and completes only after zero old-version rows", async () => {
    const runtime = await rotationEnvironment(["KEY-A", "KEY-B"]);
    const created = await createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-live", shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" });
    const first = await processEncryptionRotation({ env: runtime.env, limit: 1, now: NOW, runId: created.runId });
    expect(first).toMatchObject({ completed: false, oldVersionRows: 1, processedItems: 1, status: "running" });
    const second = await processEncryptionRotation({ env: runtime.env, limit: 1, now: new Date(NOW.getTime() + 1_000), runId: created.runId });
    expect(second).toMatchObject({ completed: true, oldVersionRows: 0, processedItems: 2, status: "completed" });
    for (const row of runtime.getInventory().values()) {
      expect(row.keyVersion).toBe("v2");
      await expect(decryptInventoryKey({ ...row, kek: KEK_V2 })).resolves.toMatch(/^KEY-/u);
    }
  });

  it("fences a stale item lease and safely resumes the failed item", async () => {
    const runtime = await rotationEnvironment(["KEY-A"]);
    const created = await createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-race", shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" });
    runtime.setStealItemLease(true);
    const raced = await processEncryptionRotation({ env: runtime.env, limit: 1, now: NOW, runId: created.runId });
    expect(raced).toMatchObject({ completed: false, oldVersionRows: 1, status: "running" });
    expect(runtime.getResourceWrites()).toBe(0);

    const item = Array.from(runtime.getItems().values())[0];
    if (item === undefined) throw new Error("rotation item missing");
    Object.assign(item, { leaseExpiresAt: new Date(NOW.getTime() - 1).toISOString(), leaseToken: "stolen-lease", status: "processing" });
    runtime.setStealItemLease(false);
    const resumed = await processEncryptionRotation({ env: runtime.env, limit: 1, now: new Date(NOW.getTime() + 1_000), runId: created.runId });
    expect(resumed).toMatchObject({ completed: true, oldVersionRows: 0, status: "completed" });
    expect(runtime.getResourceWrites()).toBe(1);
  });

  it("reopens a completed item when its resource returns to the source version", async () => {
    const runtime = await rotationEnvironment(["KEY-A"]);
    const created = await createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-reappear", shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" });
    await processEncryptionRotation({ env: runtime.env, now: NOW, runId: created.runId });
    const row = runtime.getInventory().get("key-0");
    if (row === undefined) throw new Error("inventory row missing");
    const sourceAgain = await encryptInventoryKey({ hmacSecret: "identifier-secret", keyVersion: "v1", kek: KEK_V1, plaintext: "KEY-A", shopId: row.shopId, variantId: row.variantId });
    Object.assign(row, sourceAgain);

    const repaired = await processEncryptionRotation({ env: runtime.env, now: new Date(NOW.getTime() + 1_000), runId: created.runId });
    expect(repaired).toMatchObject({ completed: true, oldVersionRows: 0, status: "completed" });
    expect(row.keyVersion).toBe("v2");
    expect(runtime.getResourceWrites()).toBe(2);
  });

  it("blocks overlapping global and shop rotations for the same key family", async () => {
    const runtime = await rotationEnvironment(["KEY-A"]);
    await createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-shop", shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" });
    await expect(createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-other-shop", shopId: "shop-b", sourceKeyVersion: "v1", targetKeyVersion: "v2" })).resolves.toMatchObject({ status: "planned" });
    await expect(createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-global", sourceKeyVersion: "v1", targetKeyVersion: "v2" })).rejects.toMatchObject({ code: "rotation_run_overlap" });
  });

  it("returns a completed run after the retired source KEK is removed", async () => {
    const runtime = await rotationEnvironment(["KEY-A"]);
    const created = await createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-retired", shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" });
    await processEncryptionRotation({ env: runtime.env, now: NOW, runId: created.runId });
    Object.assign(runtime.env, { INVENTORY_KEK_V1: undefined });
    await expect(processEncryptionRotation({ env: runtime.env, now: new Date(NOW.getTime() + 1_000), runId: created.runId })).resolves.toMatchObject({ completed: true, oldVersionRows: 0, status: "completed" });
  });

  it("rotates PayOS, Telegram credential and Telegram recipient ciphertext with exact versions", async () => {
    const payment = { apiKey: "api-secret", checksumKey: "checksum-secret", clientId: "client-secret" };
    const telegram = { botToken: "123456789:abcdefghijklmnopqrstuvwxyzABCDE", webhookSecret: "webhook-secret" };
    const runtime = await rotationEnvironment({ paymentCredentials: [payment], telegramCredentials: [telegram], telegramRecipients: ["9007199254740000"] });
    const originalIvs = {
      payment: runtime.getPaymentCredentials().get("payment-0")?.clientIdIvB64,
      recipient: runtime.getTelegramRecipients().get("telegram-recipient-0")?.ivB64,
      telegram: runtime.getTelegramCredentials().get("telegram-credential-0")?.botTokenIvB64,
    };

    for (const [keyFamily, requestId] of [["payment_credentials", "payment"], ["telegram_credentials", "telegram"], ["telegram_recipient_ids", "recipient"]] as const) {
      const created = await createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily, requestId, shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" });
      await expect(processEncryptionRotation({ env: runtime.env, now: NOW, runId: created.runId })).resolves.toMatchObject({ completed: true, oldVersionRows: 0 });
    }

    const paymentRow = runtime.getPaymentCredentials().get("payment-0");
    const telegramRow = runtime.getTelegramCredentials().get("telegram-credential-0");
    const recipientRow = runtime.getTelegramRecipients().get("telegram-recipient-0");
    if (paymentRow === undefined || telegramRow === undefined || recipientRow === undefined) throw new Error("rotated resource missing");
    expect(paymentRow.keyVersion).toBe("v2");
    expect(paymentRow.clientIdIvB64).not.toBe(originalIvs.payment);
    await expect(decryptPayOSCredentials(paymentRow, { credentialId: paymentRow.id, integrationId: paymentRow.integrationId, kek: KEK_V2, keyVersion: paymentRow.keyVersion, shopId: paymentRow.shopId })).resolves.toEqual(payment);
    expect(telegramRow.keyVersion).toBe("v2");
    expect(telegramRow.botTokenIvB64).not.toBe(originalIvs.telegram);
    await expect(decryptTelegramCredential(telegramRow, { credentialId: telegramRow.id, integrationId: telegramRow.integrationId, kek: KEK_V2, keyVersion: telegramRow.keyVersion, shopId: telegramRow.shopId })).resolves.toEqual(telegram);
    expect(recipientRow.keyVersion).toBe("v2");
    expect(recipientRow.ivB64).not.toBe(originalIvs.recipient);
    await expect(decryptTelegramChatId(recipientRow, { identityId: recipientRow.identityId, integrationId: recipientRow.integrationId, kek: KEK_V2, keyVersion: recipientRow.keyVersion, shopId: recipientRow.shopId })).resolves.toBe("9007199254740000");
    expect(runtime.getResourceWrites()).toBe(3);
  });

  it("rotates generated-license provider credentials and artifacts with their original AAD identities", async () => {
    const providerSecrets = { credential: "seller-provider-secret", endpoint: "https://seller.example.test/licenses" };
    const artifactPlaintext = "SELLER-GENERATED-LICENSE-SECRET";
    const runtime = await rotationEnvironment({
      generatedLicenseArtifacts: [{ format: "text", plaintext: artifactPlaintext }],
      generatedLicenseCredentials: [providerSecrets],
    });
    const credentialBefore = runtime.getGeneratedLicenseCredentials().get("generated-license-credential-0");
    const artifactBefore = runtime.getGeneratedLicenseArtifacts().get("generated-license-artifact-0");
    if (credentialBefore === undefined || artifactBefore === undefined) throw new Error("generated-license seed missing");
    const original = {
      artifactFingerprint: artifactBefore.artifactFingerprint,
      artifactIv: artifactBefore.ivB64,
      credentialFingerprint: credentialBefore.credentialFingerprint,
      credentialIv: credentialBefore.credentialIvB64,
      endpointFingerprint: credentialBefore.endpointFingerprint,
    };

    for (const keyFamily of ["generated_license_credentials", "generated_license_artifacts"] as const) {
      const created = await createEncryptionRotation({
        dryRun: false,
        env: runtime.env,
        keyFamily,
        requestId: `request-${keyFamily}`,
        shopId: "shop-a",
        sourceKeyVersion: "v1",
        targetKeyVersion: "v2",
      });
      await expect(processEncryptionRotation({ env: runtime.env, now: NOW, runId: created.runId }))
        .resolves.toMatchObject({ completed: true, oldVersionRows: 0, status: "completed" });
    }

    const credential = runtime.getGeneratedLicenseCredentials().get("generated-license-credential-0");
    const artifact = runtime.getGeneratedLicenseArtifacts().get("generated-license-artifact-0");
    if (credential === undefined || artifact === undefined) throw new Error("rotated generated-license resource missing");
    expect(credential).toMatchObject({
      credentialFingerprint: original.credentialFingerprint,
      endpointFingerprint: original.endpointFingerprint,
      keyVersion: "v2",
      version: 2,
    });
    expect(credential.credentialIvB64).not.toBe(original.credentialIv);
    await expect(decryptGeneratedLicenseProviderSecrets(credential, {
      connectionId: credential.connectionId,
      credentialId: credential.id,
      kek: KEK_V2,
      keyVersion: credential.keyVersion,
      shopId: credential.shopId,
    })).resolves.toEqual(providerSecrets);
    expect(artifact).toMatchObject({ artifactFingerprint: original.artifactFingerprint, keyVersion: "v2" });
    expect(artifact.ivB64).not.toBe(original.artifactIv);
    await expect(decryptGeneratedLicenseArtifact(artifact, {
      artifactId: artifact.artifactId,
      format: artifact.format,
      kek: KEK_V2,
      keyVersion: artifact.keyVersion,
      requestId: artifact.requestId,
      shopId: artifact.shopId,
    })).resolves.toBe(artifactPlaintext);
    expect(JSON.stringify({ audits: runtime.getAudits(), items: Array.from(runtime.getItems().values()) }))
      .not.toMatch(/seller-provider-secret|SELLER-GENERATED-LICENSE-SECRET/u);
  });

  it("retries a generated-license rotation after a fenced write loses CAS", async () => {
    const runtime = await rotationEnvironment({
      generatedLicenseCredentials: [{ credential: "retry-secret", endpoint: "https://retry.example.test" }],
    });
    const created = await createEncryptionRotation({
      dryRun: false,
      env: runtime.env,
      keyFamily: "generated_license_credentials",
      requestId: "request-generated-retry",
      shopId: "shop-a",
      sourceKeyVersion: "v1",
      targetKeyVersion: "v2",
    });
    runtime.setGeneratedResourceWriteFailures(1);
    await expect(processEncryptionRotation({ env: runtime.env, now: NOW, runId: created.runId }))
      .resolves.toMatchObject({ completed: false, failedItems: 1, oldVersionRows: 1, status: "paused" });
    expect(Array.from(runtime.getItems().values())[0]).toMatchObject({
      attempts: 1,
      lastSafeErrorCode: "encryption_rotation_fence_lost",
      status: "failed",
    });

    await expect(processEncryptionRotation({ env: runtime.env, now: new Date(NOW.getTime() + 1_000), runId: created.runId }))
      .resolves.toMatchObject({ completed: true, failedItems: 0, oldVersionRows: 0, status: "completed" });
    expect(Array.from(runtime.getItems().values())[0]).toMatchObject({ attempts: 2, lastSafeErrorCode: null, status: "completed" });
  });

  it("pauses corrupted generated-license ciphertext for manual review without leaking plaintext", async () => {
    const secret = "CORRUPTED-GENERATED-LICENSE-SECRET";
    const runtime = await rotationEnvironment({
      generatedLicenseArtifacts: [{ format: "text", plaintext: secret }],
    });
    const artifact = runtime.getGeneratedLicenseArtifacts().get("generated-license-artifact-0");
    if (artifact === undefined) throw new Error("generated-license artifact missing");
    artifact.ciphertextB64 = "invalid-ciphertext";
    const created = await createEncryptionRotation({
      dryRun: false,
      env: runtime.env,
      keyFamily: "generated_license_artifacts",
      requestId: "request-generated-manual-review",
      shopId: "shop-a",
      sourceKeyVersion: "v1",
      targetKeyVersion: "v2",
    });

    await expect(processEncryptionRotation({ env: runtime.env, now: NOW, runId: created.runId }))
      .resolves.toMatchObject({ completed: false, failedItems: 1, oldVersionRows: 1, status: "paused" });
    const item = Array.from(runtime.getItems().values())[0];
    expect(item).toMatchObject({
      attempts: 1,
      lastSafeErrorCode: "encryption_rotation_manual_review",
      status: "manual_review",
    });
    expect(JSON.stringify({ audits: runtime.getAudits(), item })).not.toContain(secret);
    expect(runtime.getResourceWrites()).toBe(0);
  });

  it("writes deduplicated aggregate audits without plaintext", async () => {
    const runtime = await rotationEnvironment(["SECRET-LICENSE-KEY"]);
    const created = await createEncryptionRotation({ dryRun: false, env: runtime.env, keyFamily: "inventory", requestId: "request-audit", requestedByUserId: "user-a", shopId: "shop-a", sourceKeyVersion: "v1", targetKeyVersion: "v2" });
    await processEncryptionRotation({ env: runtime.env, now: NOW, runId: created.runId });
    await processEncryptionRotation({ env: runtime.env, now: new Date(NOW.getTime() + 1_000), runId: created.runId });
    expect(runtime.getAudits().map((audit) => audit.action)).toEqual(["encryption_rotation.created", "encryption_rotation.completed"]);
    expect(JSON.stringify(runtime.getAudits())).not.toContain("SECRET-LICENSE-KEY");
  });
});
