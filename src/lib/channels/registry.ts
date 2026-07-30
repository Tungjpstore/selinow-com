import { AppError } from "../core/errors";
import { CHANNEL_CAPABILITIES } from "./types";
import type {
  ChannelAdapterManifest,
  ChannelCapability,
  ChannelCapabilityContext,
  ChannelRegistryHealthReport,
} from "./types";

const ADAPTER_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const KNOWN_CAPABILITIES = new Set<ChannelCapability>(CHANNEL_CAPABILITIES);

function assertManifest(manifest: ChannelAdapterManifest): void {
  if (manifest.code.length > 64 || !ADAPTER_CODE.test(manifest.code)) {
    throw new AppError("channel_registry_invalid", 500, ["adapter_code_invalid"]);
  }
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) {
    throw new AppError("channel_registry_invalid", 500, ["adapter_version_invalid"]);
  }
  const uniqueCapabilities = new Set(manifest.capabilities);
  if (uniqueCapabilities.size !== manifest.capabilities.length) {
    throw new AppError("channel_registry_invalid", 500, ["capability_duplicate"]);
  }
  if (manifest.capabilities.some((capability) => !KNOWN_CAPABILITIES.has(capability))) {
    throw new AppError("channel_registry_invalid", 500, ["capability_unknown"]);
  }
}

export class ChannelAdapterRegistry {
  private readonly manifests: ReadonlyMap<string, ChannelAdapterManifest>;

  constructor(manifests: readonly ChannelAdapterManifest[]) {
    const entries = new Map<string, ChannelAdapterManifest>();
    for (const manifest of manifests) {
      assertManifest(manifest);
      if (entries.has(manifest.code)) throw new AppError("channel_registry_invalid", 500, ["adapter_duplicate"]);
      entries.set(manifest.code, Object.freeze({ ...manifest, capabilities: Object.freeze([...manifest.capabilities]) }));
    }
    this.manifests = entries;
  }

  get(code: string): ChannelAdapterManifest | null {
    return this.manifests.get(code) ?? null;
  }

  list(): readonly ChannelAdapterManifest[] {
    return [...this.manifests.values()];
  }

  health(referencedProviderCodes: readonly string[] = []): ChannelRegistryHealthReport {
    const referenced = [...new Set(referencedProviderCodes)].sort();
    const unknownProviderCodes = referenced.filter((code) => !this.manifests.has(code));
    return Object.freeze({
      adapters: Object.freeze(this.list()
        .map((manifest) => Object.freeze({
          capabilityCount: manifest.capabilities.length,
          code: manifest.code,
          version: manifest.version,
        }))
        .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))),
      referencedProviderCodes: Object.freeze(referenced),
      status: unknownProviderCodes.length === 0 ? "healthy" : "unhealthy",
      unknownProviderCodes: Object.freeze(unknownProviderCodes),
    });
  }

  require(code: string): ChannelAdapterManifest {
    const manifest = this.get(code);
    if (manifest === null) throw new AppError("channel_adapter_unknown", 404);
    return manifest;
  }

  effectiveCapabilities(context: ChannelCapabilityContext): ReadonlySet<ChannelCapability> {
    const manifest = this.require(context.adapterCode);
    if (context.connectionHealth !== "active") return new Set();
    const blocked = context.policyBlockedCapabilities ?? new Set<ChannelCapability>();
    return new Set(manifest.capabilities.filter((capability) => (
      context.providerGrants.has(capability)
      && context.planEntitlements.has(capability)
      && !blocked.has(capability)
    )));
  }

  requireCapability(context: ChannelCapabilityContext, capability: ChannelCapability): void {
    if (!this.effectiveCapabilities(context).has(capability)) {
      throw new AppError("channel_capability_unavailable", 403, [capability]);
    }
  }
}
