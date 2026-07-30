import { AppError } from "../core/errors";
import { sha256Json } from "../core/crypto";
import { createId, toBase64Url } from "../core/ids";
import { CHANNEL_CAPABILITIES } from "./types";
import type { ChannelAdapterRegistry } from "./registry";
import type {
  ChannelCapability,
  ChannelConnectionCapabilityProjection,
  ChannelConnectionHealth,
  ChannelConnectionRecord,
  ChannelCredentialRecord,
  ChannelCredentialStatus,
  ChannelRegistryHealthReport,
  ShopChannelRecord,
  ShopChannelStatus,
} from "./types";

const CHANNEL_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const ENCRYPTION_KEY_VERSION = /^v[1-9][0-9]{0,3}$/u;
const KNOWN_CAPABILITIES = new Set<ChannelCapability>(CHANNEL_CAPABILITIES);

const CONNECTION_TRANSITIONS: Readonly<Record<ChannelConnectionHealth, ReadonlySet<ChannelConnectionHealth>>> = {
  active: new Set(["active", "degraded", "disconnected"]),
  degraded: new Set(["active", "degraded", "disconnected"]),
  disconnected: new Set(["disconnected"]),
  pending: new Set(["active", "degraded", "disconnected", "pending"]),
};

type ShopChannelRow = {
  channelCode: string;
  createdAt: string;
  id: string;
  settingsJson: string;
  shopId: string;
  status: ShopChannelStatus;
  updatedAt: string;
  version: number;
};

type ChannelConnectionRow = {
  channelCode: string;
  connectedAt: string | null;
  createdAt: string;
  disconnectedAt: string | null;
  displayName: string | null;
  externalAccountId: string | null;
  id: string;
  lastHealthAt: string | null;
  lastSafeErrorCode: string | null;
  providerCode: string;
  publicId: string;
  settingsJson: string;
  shopChannelId: string;
  shopId: string;
  status: ChannelConnectionHealth;
  updatedAt: string;
  version: number;
};

type ProviderCodeRow = { providerCode: string };
type ProjectionGrantRow = {
  capabilityCode: string | null;
  channelStatus: ShopChannelStatus | null;
};

type CredentialRow = {
  connectionId: string;
  createdAt: string;
  createdByUserId: string;
  credentialFingerprint: string;
  id: string;
  keyVersion: string;
  providerCode: string;
  shopId: string;
  status: ChannelCredentialStatus;
  version: number;
};

function decodeBase64Url(value: string, issue: string, minimumBytes: number, maximumBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new AppError("validation_failed", 400, [issue]);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new AppError("validation_failed", 400, [issue]);
  }
  if (toBase64Url(bytes) !== value || bytes.byteLength < minimumBytes || bytes.byteLength > maximumBytes) {
    throw new AppError("validation_failed", 400, [issue]);
  }
  return bytes;
}

function parseSettings(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.freeze({ ...parsed as Record<string, unknown> })
      : Object.freeze({});
  } catch {
    return Object.freeze({});
  }
}

function serializeSettings(value: Readonly<Record<string, unknown>> | undefined): string {
  const settings = value ?? {};
  if (Object.keys(settings).length !== 0) {
    // Provider settings need an explicit safe schema before persistence. This
    // prevents access tokens and other credentials from entering metadata.
    throw new AppError("validation_failed", 400, ["channel_settings_not_supported"]);
  }
  return "{}";
}

function requireCode(value: string, issue: string): string {
  if (value.length > 64 || !CHANNEL_CODE.test(value)) {
    throw new AppError("validation_failed", 400, [issue]);
  }
  return value;
}

function optionalBoundedText(value: string | null, maximum: number, issue: string): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  let hasControlCharacter = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (normalized.length === 0 || normalized.length > maximum || hasControlCharacter) {
    throw new AppError("validation_failed", 400, [issue]);
  }
  return normalized;
}

function normalizeCapabilities(capabilities: readonly ChannelCapability[]): readonly ChannelCapability[] {
  const unique = new Set<ChannelCapability>();
  for (const capability of capabilities) {
    if (!KNOWN_CAPABILITIES.has(capability)) {
      throw new AppError("validation_failed", 400, ["channel_capability_unknown"]);
    }
    unique.add(capability);
  }
  return [...unique];
}

function mapShopChannel(row: ShopChannelRow): ShopChannelRecord {
  return {
    channelCode: row.channelCode,
    createdAt: row.createdAt,
    id: row.id,
    settings: parseSettings(row.settingsJson),
    shopId: row.shopId,
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function mapConnection(row: ChannelConnectionRow): ChannelConnectionRecord {
  return {
    channelCode: row.channelCode,
    connectedAt: row.connectedAt,
    createdAt: row.createdAt,
    disconnectedAt: row.disconnectedAt,
    displayName: row.displayName,
    externalAccountId: row.externalAccountId,
    id: row.id,
    lastHealthAt: row.lastHealthAt,
    lastSafeErrorCode: row.lastSafeErrorCode,
    providerCode: row.providerCode,
    publicId: row.publicId,
    settings: parseSettings(row.settingsJson),
    shopChannelId: row.shopChannelId,
    shopId: row.shopId,
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function mapCredential(row: CredentialRow): ChannelCredentialRecord {
  return {
    connectionId: row.connectionId,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId,
    credentialFingerprint: row.credentialFingerprint,
    id: row.id,
    keyVersion: row.keyVersion,
    providerCode: row.providerCode,
    shopId: row.shopId,
    status: row.status,
    version: row.version,
  };
}

const SHOP_CHANNEL_SELECT = `
  SELECT id, shop_id AS shopId, channel_code AS channelCode, status,
    settings_json AS settingsJson, version, created_at AS createdAt,
    updated_at AS updatedAt
  FROM shop_channels
`;

const CONNECTION_SELECT = `
  SELECT channel_connections.id, channel_connections.public_id AS publicId,
    channel_connections.shop_id AS shopId,
    channel_connections.shop_channel_id AS shopChannelId,
    shop_channels.channel_code AS channelCode,
    channel_connections.provider_code AS providerCode,
    channel_connections.external_account_id AS externalAccountId,
    channel_connections.display_name_sanitized AS displayName,
    channel_connections.status, channel_connections.settings_json AS settingsJson,
    channel_connections.last_safe_error_code AS lastSafeErrorCode,
    channel_connections.last_health_at AS lastHealthAt,
    channel_connections.connected_at AS connectedAt,
    channel_connections.disconnected_at AS disconnectedAt,
    channel_connections.version, channel_connections.created_at AS createdAt,
    channel_connections.updated_at AS updatedAt
  FROM channel_connections
  INNER JOIN shop_channels
    ON shop_channels.id = channel_connections.shop_channel_id
    AND shop_channels.shop_id = channel_connections.shop_id
`;

export class D1ChannelConnectionRepository {
  constructor(
    private readonly database: D1Database,
    private readonly registry: ChannelAdapterRegistry,
  ) {}

  async registryHealth(): Promise<ChannelRegistryHealthReport> {
    const result = await this.database.prepare(`
      SELECT DISTINCT provider_code AS providerCode
      FROM channel_connections
      WHERE status IN ('pending', 'active', 'degraded')
      ORDER BY provider_code
    `).all<ProviderCodeRow>();
    return this.registry.health(result.results.map((row) => row.providerCode));
  }

  async ensureShopChannel(input: {
    channelCode: string;
    settings?: Readonly<Record<string, unknown>>;
    shopId: string;
    status?: ShopChannelStatus;
  }): Promise<ShopChannelRecord> {
    const channelCode = requireCode(input.channelCode, "channel_code_invalid");
    const now = new Date().toISOString();
    const status = input.status ?? "enabled";
    try {
      await this.database.prepare(`
        INSERT INTO shop_channels (
          id, shop_id, channel_code, status, settings_json,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (shop_id, channel_code) DO NOTHING
      `).bind(
        createId("sch"), input.shopId, channelCode,
        status, serializeSettings(input.settings), now, now,
      ).run();
    } catch {
      throw new AppError("channel_connection_conflict", 409);
    }

    const row = await this.database.prepare(`${SHOP_CHANNEL_SELECT}
      WHERE shop_id = ? AND channel_code = ?
      LIMIT 1
    `).bind(input.shopId, channelCode).first<ShopChannelRow>();
    if (row === null) throw new AppError("channel_connection_conflict", 409);
    return mapShopChannel(row);
  }

  async createConnection(input: {
    channelCode: string;
    displayName?: string | null;
    externalAccountId?: string | null;
    idempotencyKey?: string;
    providerCode: string;
    providerGrants?: readonly ChannelCapability[];
    settings?: Readonly<Record<string, unknown>>;
    shopId: string;
  }): Promise<ChannelConnectionRecord> {
    const providerCode = requireCode(input.providerCode, "channel_provider_code_invalid");
    this.registry.require(providerCode);
    const externalAccountId = optionalBoundedText(input.externalAccountId ?? null, 256, "channel_external_account_invalid");
    const displayName = optionalBoundedText(input.displayName ?? null, 200, "channel_display_name_invalid");
    const idempotencyKey = input.idempotencyKey === undefined
      ? null
      : optionalBoundedText(input.idempotencyKey, 128, "channel_idempotency_key_invalid");
    if (idempotencyKey !== null && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new AppError("validation_failed", 400, ["channel_idempotency_key_invalid"]);
    }
    if (externalAccountId === null && idempotencyKey === null) {
      throw new AppError("validation_failed", 400, ["channel_idempotency_key_required"]);
    }
    const connectIntentKeyHash = idempotencyKey === null
      ? null
      : await sha256Json({ idempotencyKey });
    const providerGrants = normalizeCapabilities(input.providerGrants ?? []);
    const settingsJson = serializeSettings(input.settings);
    const channel = await this.ensureShopChannel({ channelCode: input.channelCode, shopId: input.shopId });
    if (channel.status === "disabled") {
      throw new AppError("channel_connection_unavailable", 409, ["shop_channel_disabled"]);
    }

    const connectionId = createId("chn");
    const publicId = createId("channel");
    const now = new Date().toISOString();
    if (externalAccountId !== null) {
      const replay = await this.findLiveExternalIdentity(input.shopId, providerCode, externalAccountId);
      if (replay !== null) {
        if (replay.channelCode !== channel.channelCode) {
          throw new AppError("channel_connection_conflict", 409);
        }
        return replay;
      }
    } else if (connectIntentKeyHash !== null) {
      const replay = await this.findOpenConnectIntent(
        input.shopId, channel.id, providerCode, connectIntentKeyHash,
      );
      if (replay !== null) return replay;
    }
    const statements = [
      this.database.prepare(`
        INSERT INTO channel_connections (
          id, public_id, shop_id, shop_channel_id, provider_code,
          external_account_id, connect_intent_key_hash, display_name_sanitized,
          status, settings_json,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)
      `).bind(
        connectionId, publicId, input.shopId, channel.id, providerCode,
        externalAccountId, connectIntentKeyHash, displayName, settingsJson, now, now,
      ),
      ...providerGrants.map((capability) => this.database.prepare(`
        INSERT INTO channel_connection_grants (
          shop_id, connection_id, capability_code, granted_at
        ) VALUES (?, ?, ?, ?)
      `).bind(input.shopId, connectionId, capability, now)),
    ];
    try {
      await this.database.batch(statements);
    } catch {
      if (externalAccountId !== null) {
        const replay = await this.findLiveExternalIdentity(input.shopId, providerCode, externalAccountId);
        if (replay !== null && replay.channelCode === channel.channelCode) return replay;
      }
      if (externalAccountId === null && connectIntentKeyHash !== null) {
        const replay = await this.findOpenConnectIntent(
          input.shopId, channel.id, providerCode, connectIntentKeyHash,
        );
        if (replay !== null) return replay;
      }
      throw new AppError("channel_connection_conflict", 409);
    }

    const connection = await this.get(input.shopId, connectionId);
    if (connection === null) throw new AppError("channel_connection_conflict", 409);
    return connection;
  }

  async get(shopId: string, connectionId: string): Promise<ChannelConnectionRecord | null> {
    const row = await this.database.prepare(`${CONNECTION_SELECT}
      WHERE channel_connections.shop_id = ? AND channel_connections.id = ?
      LIMIT 1
    `).bind(shopId, connectionId).first<ChannelConnectionRow>();
    return row === null ? null : mapConnection(row);
  }

  private async findLiveExternalIdentity(
    shopId: string,
    providerCode: string,
    externalAccountId: string,
  ): Promise<ChannelConnectionRecord | null> {
    const row = await this.database.prepare(`${CONNECTION_SELECT}
      WHERE channel_connections.shop_id = ?
        AND channel_connections.provider_code = ?
        AND channel_connections.external_account_id = ?
        AND channel_connections.status IN ('pending', 'active', 'degraded')
      LIMIT 1
    `).bind(shopId, providerCode, externalAccountId).first<ChannelConnectionRow>();
    return row === null ? null : mapConnection(row);
  }

  private async findOpenConnectIntent(
    shopId: string,
    shopChannelId: string,
    providerCode: string,
    connectIntentKeyHash: string,
  ): Promise<ChannelConnectionRecord | null> {
    const row = await this.database.prepare(`${CONNECTION_SELECT}
      WHERE channel_connections.shop_id = ?
        AND channel_connections.shop_channel_id = ?
        AND channel_connections.provider_code = ?
        AND channel_connections.connect_intent_key_hash = ?
        AND channel_connections.external_account_id IS NULL
        AND channel_connections.status IN ('pending', 'active', 'degraded')
      LIMIT 1
    `).bind(shopId, shopChannelId, providerCode, connectIntentKeyHash).first<ChannelConnectionRow>();
    return row === null ? null : mapConnection(row);
  }

  async list(shopId: string, channelCode?: string): Promise<readonly ChannelConnectionRecord[]> {
    const rows = channelCode === undefined
      ? await this.database.prepare(`${CONNECTION_SELECT}
          WHERE channel_connections.shop_id = ?
          ORDER BY channel_connections.created_at, channel_connections.id
          LIMIT 500
        `).bind(shopId).all<ChannelConnectionRow>()
      : await this.database.prepare(`${CONNECTION_SELECT}
          WHERE channel_connections.shop_id = ? AND shop_channels.channel_code = ?
          ORDER BY channel_connections.created_at, channel_connections.id
          LIMIT 500
        `).bind(shopId, requireCode(channelCode, "channel_code_invalid")).all<ChannelConnectionRow>();
    return rows.results.map(mapConnection);
  }

  async setStatus(input: {
    connectionId: string;
    expectedVersion: number;
    lastSafeErrorCode?: string | null;
    shopId: string;
    status: ChannelConnectionHealth;
  }): Promise<ChannelConnectionRecord> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AppError("validation_failed", 400, ["channel_connection_version_invalid"]);
    }
    const safeError = input.lastSafeErrorCode === undefined || input.lastSafeErrorCode === null
      ? null
      : requireCode(input.lastSafeErrorCode, "channel_safe_error_code_invalid");
    if (safeError !== null && !SAFE_ERROR_CODE.test(safeError)) {
      throw new AppError("validation_failed", 400, ["channel_safe_error_code_invalid"]);
    }
    const current = await this.get(input.shopId, input.connectionId);
    if (current === null) throw new AppError("channel_connection_not_found", 404);
    if (current.version !== input.expectedVersion) {
      throw new AppError("channel_connection_version_conflict", 409);
    }
    if (!CONNECTION_TRANSITIONS[current.status].has(input.status)) {
      throw new AppError("channel_connection_transition_invalid", 409, [
        `${current.status}->${input.status}`,
      ]);
    }
    const now = new Date().toISOString();
    const row = await this.database.prepare(`
      UPDATE channel_connections
      SET status = ?, last_safe_error_code = ?, last_health_at = ?,
        connected_at = CASE
          WHEN ? = 'active' THEN COALESCE(connected_at, ?)
          ELSE connected_at
        END,
        disconnected_at = CASE
          WHEN ? = 'disconnected' THEN COALESCE(disconnected_at, ?)
          ELSE NULL
        END,
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND id = ? AND version = ?
      RETURNING id
    `).bind(
      input.status, safeError, now, input.status, now,
      input.status, now, now, input.shopId, input.connectionId, input.expectedVersion,
    ).first<{ id: string }>();
    if (row === null) {
      const currentAfterRace = await this.get(input.shopId, input.connectionId);
      if (currentAfterRace === null) throw new AppError("channel_connection_not_found", 404);
      throw new AppError("channel_connection_version_conflict", 409);
    }
    const connection = await this.get(input.shopId, input.connectionId);
    if (connection === null) throw new AppError("channel_connection_not_found", 404);
    return connection;
  }

  async createCredentialEnvelope(input: {
    ciphertextB64: string;
    createdByUserId: string;
    fingerprint: string;
    ivB64: string;
    keyVersion: string;
    connectionId: string;
    shopId: string;
  }): Promise<ChannelCredentialRecord> {
    if (!ENCRYPTION_KEY_VERSION.test(input.keyVersion)) {
      throw new AppError("validation_failed", 400, ["channel_credential_key_version_invalid"]);
    }
    const ciphertext = decodeBase64Url(input.ciphertextB64, "channel_credential_ciphertext_invalid", 16, 24_576);
    const iv = decodeBase64Url(input.ivB64, "channel_credential_iv_invalid", 12, 12);
    const fingerprint = decodeBase64Url(input.fingerprint, "channel_credential_fingerprint_invalid", 32, 32);
    if (ciphertext.byteLength < 16 || iv.byteLength !== 12 || fingerprint.byteLength !== 32) {
      throw new AppError("validation_failed", 400, ["channel_credential_envelope_invalid"]);
    }

    const connection = await this.get(input.shopId, input.connectionId);
    if (connection === null) throw new AppError("channel_connection_not_found", 404);
    const member = await this.database.prepare(`
      SELECT 1 AS member
      FROM shop_members
      WHERE shop_id = ? AND user_id = ? AND status = 'active'
      LIMIT 1
    `).bind(input.shopId, input.createdByUserId).first<{ member: number }>();
    if (member === null) {
      throw new AppError("channel_credential_actor_forbidden", 403);
    }
    const nextVersion = await this.database.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM channel_credentials
      WHERE shop_id = ? AND connection_id = ?
    `).bind(input.shopId, input.connectionId).first<{ version: number }>();
    if (nextVersion === null) throw new AppError("channel_credential_conflict", 409);

    const credentialId = createId("ccred");
    const now = new Date().toISOString();
    try {
      await this.database.prepare(`
        INSERT INTO channel_credentials (
          id, shop_id, connection_id, provider_code, status, version,
          key_version, credential_envelope_ciphertext_b64,
          credential_envelope_iv_b64, credential_fingerprint,
          created_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        credentialId, input.shopId, input.connectionId, connection.providerCode,
        nextVersion.version, input.keyVersion, input.ciphertextB64, input.ivB64,
        input.fingerprint, input.createdByUserId, now,
      ).run();
    } catch (error) {
      if (error instanceof Error && error.message.includes("channel_credential_actor_not_tenant_member")) {
        throw new AppError("channel_credential_actor_forbidden", 403);
      }
      throw new AppError("channel_credential_conflict", 409);
    }

    const row = await this.database.prepare(`
      SELECT id, shop_id AS shopId, connection_id AS connectionId,
        provider_code AS providerCode, status, version,
        key_version AS keyVersion, credential_fingerprint AS credentialFingerprint,
        created_by_user_id AS createdByUserId, created_at AS createdAt
      FROM channel_credentials
      WHERE shop_id = ? AND connection_id = ? AND id = ?
      LIMIT 1
    `).bind(input.shopId, input.connectionId, credentialId).first<CredentialRow>();
    if (row === null) throw new AppError("channel_credential_conflict", 409);
    return mapCredential(row);
  }

  async projectCapabilities(input: {
    connectionId: string;
    now?: Date;
    planEntitlements: ReadonlySet<ChannelCapability>;
    policyBlockedCapabilities?: ReadonlySet<ChannelCapability>;
    shopId: string;
  }): Promise<ChannelConnectionCapabilityProjection> {
    const connection = await this.get(input.shopId, input.connectionId);
    if (connection === null) throw new AppError("channel_connection_not_found", 404);
    const now = (input.now ?? new Date()).toISOString();
    // Read the parent channel and its live grants in one tenant-bound query.
    // A connection must never project capabilities while its channel is
    // pending or disabled, even if the connection and grants remain live.
    const rows = await this.database.prepare(`
      SELECT shop_channels.status AS channelStatus,
        channel_connection_grants.capability_code AS capabilityCode
      FROM channel_connections
      INNER JOIN shop_channels
        ON shop_channels.id = channel_connections.shop_channel_id
        AND shop_channels.shop_id = channel_connections.shop_id
      LEFT JOIN channel_connection_grants
        ON channel_connection_grants.shop_id = channel_connections.shop_id
        AND channel_connection_grants.connection_id = channel_connections.id
        AND (channel_connection_grants.expires_at IS NULL OR channel_connection_grants.expires_at > ?)
      WHERE channel_connections.shop_id = ? AND channel_connections.id = ?
      ORDER BY channel_connection_grants.capability_code
    `).bind(now, input.shopId, input.connectionId).all<ProjectionGrantRow>();
    const providerGrants = new Set<ChannelCapability>();
    for (const row of rows.results) {
      if (row.capabilityCode !== null && KNOWN_CAPABILITIES.has(row.capabilityCode as ChannelCapability)) {
        providerGrants.add(row.capabilityCode as ChannelCapability);
      }
    }
    const context = {
      adapterCode: connection.providerCode,
      connectionHealth: connection.status,
      planEntitlements: input.planEntitlements,
      providerGrants,
      ...(input.policyBlockedCapabilities === undefined
        ? {}
        : { policyBlockedCapabilities: input.policyBlockedCapabilities }),
    };
    const channelEnabled = rows.results.some((row) => row.channelStatus === "enabled");
    return {
      capabilities: channelEnabled
        ? this.registry.effectiveCapabilities(context)
        : new Set<ChannelCapability>(),
      connection,
      providerGrants,
    };
  }
}
