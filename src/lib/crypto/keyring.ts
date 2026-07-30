import { AppError } from "../core/errors";

export type EncryptionKeyFamily = "credential" | "export" | "inventory";

export type KeyringBindings = {
  ACTIVE_CREDENTIAL_KEY_VERSION?: string;
  ACTIVE_INVENTORY_KEY_VERSION?: string;
  CREDENTIAL_KEK_V1?: string;
  CREDENTIAL_KEK_V2?: string;
  CREDENTIAL_KEY_VERSION?: string;
  EXPORT_KEK_V1?: string;
  EXPORT_KEY_VERSION?: string;
  INVENTORY_KEK_V1?: string;
  INVENTORY_KEK_V2?: string;
  INVENTORY_KEY_VERSION?: string;
};

export type ResolvedEncryptionKey = {
  family: EncryptionKeyFamily;
  kek: string;
  version: string;
};

const VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/u;

function configuredValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function keyForVersion(env: KeyringBindings, family: EncryptionKeyFamily, version: string): string | null {
  if (family === "credential") {
    if (version === "v1") return configuredValue(env.CREDENTIAL_KEK_V1);
    if (version === "v2") return configuredValue(env.CREDENTIAL_KEK_V2);
    return null;
  }
  if (family === "inventory") {
    if (version === "v1") return configuredValue(env.INVENTORY_KEK_V1);
    if (version === "v2") return configuredValue(env.INVENTORY_KEK_V2);
    return null;
  }
  return version === "v1" ? configuredValue(env.EXPORT_KEK_V1) : null;
}

export function resolveEncryptionKey(env: KeyringBindings, family: EncryptionKeyFamily, version: string): ResolvedEncryptionKey {
  if (!VERSION_PATTERN.test(version)) throw new AppError("encryption_key_version_invalid", 500);
  const kek = keyForVersion(env, family, version);
  if (kek === null) throw new AppError("encryption_key_version_unavailable", 500);
  return { family, kek, version };
}

export function resolveActiveEncryptionKey(env: KeyringBindings, family: EncryptionKeyFamily): ResolvedEncryptionKey {
  const version = family === "credential"
    ? configuredValue(env.ACTIVE_CREDENTIAL_KEY_VERSION) ?? configuredValue(env.CREDENTIAL_KEY_VERSION)
    : family === "inventory"
      ? configuredValue(env.ACTIVE_INVENTORY_KEY_VERSION) ?? configuredValue(env.INVENTORY_KEY_VERSION)
      : configuredValue(env.EXPORT_KEY_VERSION);
  if (version === null) throw new AppError("active_encryption_key_version_missing", 500);
  return resolveEncryptionKey(env, family, version);
}
