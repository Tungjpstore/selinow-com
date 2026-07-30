import { AppError } from "../core/errors";
import { assertCapabilityDefinition, DEFAULT_AUTOMATION_RETRY_POLICY } from "./policy";
import type { AutomationCapabilityDefinition } from "./types";

const NO_RETRY = {
  baseDelaySeconds: 1,
  maxAttempts: 1,
  maxDelaySeconds: 1,
} as const;

export const DEFAULT_AUTOMATION_CAPABILITIES: readonly AutomationCapabilityDefinition[] = [
  { code: "shop.provision", level: "automatic", retryPolicy: DEFAULT_AUTOMATION_RETRY_POLICY },
  { code: "domain.platform.provision", level: "automatic", retryPolicy: DEFAULT_AUTOMATION_RETRY_POLICY },
  { code: "domain.custom.cloudflare_hostname", level: "automatic", retryPolicy: DEFAULT_AUTOMATION_RETRY_POLICY },
  { code: "domain.custom.domain_connect", level: "approval_required", retryPolicy: DEFAULT_AUTOMATION_RETRY_POLICY },
  { code: "domain.custom.manual_dns", level: "external_action", retryPolicy: DEFAULT_AUTOMATION_RETRY_POLICY },
  { code: "telegram.bot.create", level: "external_action", retryPolicy: DEFAULT_AUTOMATION_RETRY_POLICY },
  { code: "payments.payos.channel_create", level: "external_action", retryPolicy: DEFAULT_AUTOMATION_RETRY_POLICY },
  { code: "domain.custom.apex", level: "unsupported", retryPolicy: NO_RETRY },
];

export class AutomationCapabilityRegistry {
  private readonly definitions: ReadonlyMap<string, AutomationCapabilityDefinition>;

  constructor(definitions: readonly AutomationCapabilityDefinition[]) {
    const entries = new Map<string, AutomationCapabilityDefinition>();
    for (const definition of definitions) {
      assertCapabilityDefinition(definition);
      if (entries.has(definition.code)) throw new AppError("automation_registry_invalid", 500, ["capability_duplicate"]);
      entries.set(definition.code, definition);
    }
    this.definitions = entries;
  }

  get(code: string): AutomationCapabilityDefinition | null {
    return this.definitions.get(code) ?? null;
  }

  require(code: string): AutomationCapabilityDefinition {
    const definition = this.get(code);
    if (definition === null) throw new AppError("automation_capability_unknown", 404);
    return definition;
  }

  list(): readonly AutomationCapabilityDefinition[] {
    return [...this.definitions.values()];
  }
}

export const defaultAutomationCapabilityRegistry = new AutomationCapabilityRegistry(DEFAULT_AUTOMATION_CAPABILITIES);
