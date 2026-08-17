import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { commonCatalogs } from "../../src/lib/i18n/catalogs/common";
import { adminCatalogs } from "../../src/lib/i18n/catalogs/admin";
import { dashboardCatalogs } from "../../src/lib/i18n/catalogs/dashboard";
import { marketingCatalogs } from "../../src/lib/i18n/catalogs/marketing";
import { onboardingCatalogs } from "../../src/lib/i18n/catalogs/onboarding";
import { storefrontCatalogs } from "../../src/lib/i18n/catalogs/storefront";
import { systemCatalogs } from "../../src/lib/i18n/catalogs/system";
import { TELEGRAM_CATALOG } from "../../src/lib/telegram/localization";

type CatalogName = "admin" | "common" | "dashboard" | "marketing" | "onboarding" | "storefront" | "system" | "telegram";
type SourceFile = { path: string; source: string };
type TranslationReference = {
  catalog: CatalogName;
  expression: string;
  factory: string | null;
  identifier: string;
  index: number;
  kind: "translator" | "telegram";
  path: string;
  source: string;
};
type DynamicAllowlistEntry = {
  catalog: CatalogName;
  expression: string;
  guard: RegExp;
  identifier: string;
  path: string;
};

const CATALOG_GROUPS: Readonly<Record<CatalogName, Readonly<Record<"en" | "vi-VN", Readonly<Record<string, string>>>>>> = {
  admin: adminCatalogs,
  common: commonCatalogs,
  dashboard: dashboardCatalogs,
  marketing: marketingCatalogs,
  onboarding: onboardingCatalogs,
  storefront: storefrontCatalogs,
  system: systemCatalogs,
  telegram: TELEGRAM_CATALOG,
};

const FACTORY_CATALOG: Readonly<Record<string, CatalogName>> = {
  Admin: "admin",
  Dashboard: "dashboard",
  Marketing: "marketing",
  Onboarding: "onboarding",
  Storefront: "storefront",
  System: "system",
};

const CATALOG_KEY_PREFIXES: Readonly<Record<CatalogName, readonly string[]>> = {
  admin: ["admin."],
  common: ["common.", "commerce."],
  dashboard: ["dashboard."],
  marketing: ["marketing."],
  onboarding: ["onboarding."],
  storefront: ["storefront."],
  system: ["auth.", "automation.", "error.", "integration.", "status.", "subscription.", "timeline."],
  telegram: ["button.", "cart.", "catalog.", "command.", "error.", "key.", "keys.", "menu.", "notification.", "order.", "orders.", "payment.", "status.", "webhook."],
};

const DYNAMIC_TRANSLATION_ALLOWLIST: readonly DynamicAllowlistEntry[] = [
  {
    catalog: "system",
    expression: "entry.key",
    guard: /const map:[\s\S]*status\.fulfillment\.unknown[\s\S]*createSystemTranslator\(locale\)\(entry\.key\)/u,
    identifier: "createSystemTranslator",
    path: "src/components/commerce/FulfillmentState.astro",
  },
  {
    catalog: "system",
    expression: "entry.key",
    guard: /const map:[\s\S]*status\.payment\.unknown[\s\S]*createSystemTranslator\(locale\)\(entry\.key\)/u,
    identifier: "createSystemTranslator",
    path: "src/components/commerce/PaymentState.astro",
  },
  {
    catalog: "system",
    expression: "`status.stock.${state}`",
    guard: /state: "available" \| "low_stock" \| "out_of_stock"[\s\S]*`status\.stock\.\$\{state\}`/u,
    identifier: "createSystemTranslator",
    path: "src/components/commerce/StockLabel.astro",
  },
  {
    catalog: "admin",
    expression: "`admin.layout.role.${role}`",
    guard: /role === null \? t\("admin\.layout\.role\.unverified"\) : t\(`admin\.layout\.role\.\$\{role\}`\)/u,
    identifier: "t",
    path: "src/layouts/AdminLayout.astro",
  },
  {
    catalog: "system",
    expression: "key",
    guard: /AUTOMATION_CAPABILITIES\.has\(task\.capabilityCode\)[\s\S]*return t\(key\)/u,
    identifier: "t",
    path: "src/lib/dashboard/automation-ui.ts",
  },
  {
    catalog: "system",
    expression: "keys[code] ?? \"automation.error.generic\"",
    guard: /const keys: Readonly<Record<string, string>>[\s\S]*createSystemTranslator\(locale\)\(keys\[code\] \?\? "automation\.error\.generic"\)/u,
    identifier: "createSystemTranslator",
    path: "src/lib/dashboard/automation-ui.ts",
  },
  {
    catalog: "system",
    expression: "`automation.status.${status}`",
    guard: /automationStatusLabel\(status: AutomationTaskStatus[\s\S]*`automation\.status\.\$\{status\}`/u,
    identifier: "createSystemTranslator",
    path: "src/lib/dashboard/automation-ui.ts",
  },
  {
    catalog: "system",
    expression: "`subscription.impact.${knownState}`",
    guard: /SUBSCRIPTION_STATE_TONES\[state\] === undefined \? "unknown" : state[\s\S]*`subscription\.impact\.\$\{knownState\}`/u,
    identifier: "t",
    path: "src/lib/dashboard/billing-ui.ts",
  },
  {
    catalog: "system",
    expression: "`subscription.status.${knownState}`",
    guard: /SUBSCRIPTION_STATE_TONES\[state\] === undefined \? "unknown" : state[\s\S]*`subscription\.status\.\$\{knownState\}`/u,
    identifier: "t",
    path: "src/lib/dashboard/billing-ui.ts",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.domains.status.${status}`",
    guard: /`dashboard\.domains\.status\.\$\{status\}`[\s\S]*\|\| t\("dashboard\.domains\.status\.processing"/u,
    identifier: "t",
    path: "src/lib/dashboard/domain-ui.ts",
  },
  {
    catalog: "system",
    expression: "ERROR_KEYS[code] ?? \"integration.error.generic\"",
    guard: /const ERROR_KEYS: Readonly<Record<string, string>>[\s\S]*t\(ERROR_KEYS\[code\] \?\? "integration\.error\.generic"\)/u,
    identifier: "t",
    path: "src/lib/dashboard/integrations-view.ts",
  },
  {
    catalog: "onboarding",
    expression: "key",
    guard: /ONBOARDING_CLIENT_KEYS\.map\(\(key\) => \[key, t\(key\)\]\)/u,
    identifier: "t",
    path: "src/lib/i18n/catalogs/onboarding.ts",
  },
  {
    catalog: "storefront",
    expression: "key",
    guard: /KNOWN_STATES\.has\(value\) \? t\(key\) : t\("storefront\.status\.unknown"\)/u,
    identifier: "t",
    path: "src/lib/storefront/order-view.ts",
  },
  {
    catalog: "telegram",
    expression: "key",
    guard: /Object\.hasOwn\(catalog, key\) \? telegramText\(locale, key\) : telegramText\(locale, "error\.generic"\)/u,
    identifier: "telegramText",
    path: "src/lib/telegram/commerce.ts",
  },
  {
    catalog: "telegram",
    expression: "key",
    guard: /Object\.hasOwn\(catalog, key\) \? telegramText\(resolvedLocale, key\) : telegramText\(resolvedLocale, "status\.unknown"\)/u,
    identifier: "telegramText",
    path: "src/lib/telegram/localization.ts",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.overview.readiness_check.${code}.impact`",
    guard: /readinessCopy[\s\S]*Object\.fromEntries\([\s\S]*\.map\(\(code\)[\s\S]*`dashboard\.overview\.readiness_check\.\$\{code\}\.impact`/u,
    identifier: "t",
    path: "src/pages/app/index.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.overview.readiness_check.${code}.title`",
    guard: /readinessCopy[\s\S]*Object\.fromEntries\([\s\S]*\.map\(\(code\)[\s\S]*`dashboard\.overview\.readiness_check\.\$\{code\}\.title`/u,
    identifier: "t",
    path: "src/pages/app/index.astro",
  },
  {
    catalog: "dashboard",
    expression: "key",
    guard: /role === "owner" \|\| role === "manager" \|\| role === "support" \|\| role === "viewer"[\s\S]*return t\(key\)/u,
    identifier: "t",
    path: "src/pages/app/members.astro",
  },
  {
    catalog: "system",
    expression: "`status.payment.${knownPaymentStates.has(value) ? value : \"unknown\"}`",
    guard: /const knownPaymentStates = new Set\([\s\S]*knownPaymentStates\.has\(value\) \? value : "unknown"/u,
    identifier: "systemT",
    path: "src/pages/app/orders/[id].astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.orders.exception.type.${[\"identity_mismatch\", \"inconsistent\", \"late\", \"manual_review\", \"overpaid\", \"partial\", \"failed\"].includes(value) ? value : \"default\"}`",
    guard: /dashboard\.orders\.exception\.type\.\$\{\["identity_mismatch", "inconsistent", "late", "manual_review", "overpaid", "partial", "failed"\]\.includes\(value\) \? value : "default"\}/u,
    identifier: "t",
    path: "src/pages/app/orders.astro",
  },
  {
    catalog: "marketing",
    expression: "translationKey",
    guard: /const limit = [\s\S]*t\(translationKey,[\s\S]*marketing\.pricing\.limit\.products[\s\S]*marketing\.pricing\.limit\.staff/u,
    identifier: "t",
    path: "src/pages/pricing.astro",
  },
  {
    catalog: "dashboard",
    expression: "replayed ? \"dashboard.inventory.client.import.verb.replayed\" : \"dashboard.inventory.client.import.verb.imported\"",
    guard: /const replayed = result\.replayed === true[\s\S]*t\(replayed \? "dashboard\.inventory\.client\.import\.verb\.replayed" : "dashboard\.inventory\.client\.import\.verb\.imported"\)/u,
    identifier: "t",
    path: "src/scripts/dashboard/inventory.ts",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.products.client.validation.${error.message}`",
    guard: /\["new_variant_fields_required", "new_variant_price_invalid", "new_variant_quantity_invalid"\]\.includes\(error\.message\)[\s\S]*`dashboard\.products\.client\.validation\.\$\{error\.message\}`/u,
    identifier: "t",
    path: "src/scripts/dashboard/products.ts",
  },
  {
    catalog: "system",
    expression: "busy ? \"auth.login.submitting\" : \"auth.login.submit\"",
    guard: /function setBusy\(busy: boolean\)[\s\S]*t\(busy \? "auth\.login\.submitting" : "auth\.login\.submit"\)/u,
    identifier: "t",
    path: "src/scripts/marketing/login.ts",
  },
  {
    catalog: "system",
    expression: "messageKeys[code] ?? \"auth.login.generic_error\"",
    guard: /const messageKeys: Readonly<Record<string, string>>[\s\S]*t\(messageKeys\[code\] \?\? "auth\.login\.generic_error"\)/u,
    identifier: "t",
    path: "src/scripts/marketing/login.ts",
  },
  {
    catalog: "system",
    expression: "messageKeys[code] ?? \"auth.login.generic_error\"",
    guard: /const messageKeys: Readonly<Record<string, string>>[\s\S]*t\(messageKeys\[code\] \?\? "auth\.login\.generic_error"\)/u,
    identifier: "t",
    path: "src/scripts/marketing/magic-link.ts",
  },
  {
    catalog: "dashboard",
    expression: "entry.safeDescriptionKey",
    guard: /listChannelExpansionCatalog\(\)\.map\(\(entry\) => \(\{[\s\S]*description: t\(entry\.safeDescriptionKey\)/u,
    identifier: "t",
    path: "src/pages/app/integrations.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.billing.invoices.status.${invoice.status}`",
    guard: /draft: "neutral", failed: "danger", open: "info", paid: "success", past_due: "warning", refunded: "danger", void: "neutral"[\s\S]*`dashboard\.billing\.invoices\.status\.\$\{invoice\.status\}`/u,
    identifier: "t",
    path: "src/pages/app/billing.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.security.tabs.${tab}`",
    guard: /tabKeys = \["sessions", "two_factor", "password", "history"\] as const[\s\S]*`dashboard\.security\.tabs\.\$\{tab\}`/u,
    identifier: "t",
    path: "src/pages/app/security.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.security.history.outcome.${entry.outcome}`",
    guard: /account_locked: "danger",[\s\S]*two_factor_required: "neutral",[\s\S]*`dashboard\.security\.history\.outcome\.\$\{entry\.outcome\}`/u,
    identifier: "t",
    path: "src/scripts/dashboard/security.ts",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.automation.rules.trigger.${type.replace(\".\", \"_\")}`",
    guard: /RULE_TRIGGER_TYPES\.map\(\(type\) => \(\{ label: t\(`dashboard\.automation\.rules\.trigger\.\$\{type\.replace\("\.", "_"\)\}`\)/u,
    identifier: "t",
    path: "src/components/dashboard/automation/RuleList.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.automation.rules.operator.${operator}`",
    guard: /RULE_CONDITION_OPERATORS\.map\(\(operator\) => \(\{ label: t\(`dashboard\.automation\.rules\.operator\.\$\{operator\}`\)/u,
    identifier: "t",
    path: "src/components/dashboard/automation/RuleList.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.automation.rules.action.${type.replace(\"rule_\", \"\")}`",
    guard: /RULE_ACTION_TYPES\.map\(\(type\) => \(\{ label: t\(`dashboard\.automation\.rules\.action\.\$\{type\.replace\("rule_", ""\)\}`\)/u,
    identifier: "t",
    path: "src/components/dashboard/automation/RuleList.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.automation.rules.trigger.${triggerType.replace(\".\", \"_\")}`",
    guard: /ruleTriggerLabel\(triggerType: RuleTriggerType[\s\S]*`dashboard\.automation\.rules\.trigger\.\$\{triggerType\.replace\("\.", "_"\)\}`/u,
    identifier: "t",
    path: "src/lib/dashboard/automation-rules-ui.ts",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.automation.rules.action.${actionType.replace(\"rule_\", \"\")}`",
    guard: /ruleActionLabel\(actionType: RuleActionType[\s\S]*`dashboard\.automation\.rules\.action\.\$\{actionType\.replace\("rule_", ""\)\}`/u,
    identifier: "t",
    path: "src/lib/dashboard/automation-rules-ui.ts",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.automation.rules.operator.${operator}`",
    guard: /ruleOperatorLabel\(operator: RuleConditionOperator[\s\S]*`dashboard\.automation\.rules\.operator\.\$\{operator\}`/u,
    identifier: "t",
    path: "src/lib/dashboard/automation-rules-ui.ts",
  },
  {
    catalog: "dashboard",
    expression: "enabled ? \"dashboard.automation.rules.status.enabled\" : \"dashboard.automation.rules.status.disabled\"",
    guard: /ruleStatusLabel\(enabled: boolean[\s\S]*t\(enabled \? "dashboard\.automation\.rules\.status\.enabled" : "dashboard\.automation\.rules\.status\.disabled"\)/u,
    identifier: "t",
    path: "src/lib/dashboard/automation-rules-ui.ts",
  },
  {
    catalog: "dashboard",
    expression: "keys[code] ?? \"dashboard.automation.rules.client.generic_error\"",
    guard: /const keys: Readonly<Record<string, string>>[\s\S]*t\(keys\[code\] \?\? "dashboard\.automation\.rules\.client\.generic_error"\)/u,
    identifier: "t",
    path: "src/lib/dashboard/automation-rules-ui.ts",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.store_builder.template.${template.id}.description`",
    guard: /settings\.templates\.map\(\(template\) => \(\{[\s\S]*`dashboard\.store_builder\.template\.\$\{template\.id\}\.description`/u,
    identifier: "t",
    path: "src/pages/app/store.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.store_builder.template.${template.id}.name`",
    guard: /settings\.templates\.map\(\(template\) => \(\{[\s\S]*`dashboard\.store_builder\.template\.\$\{template\.id\}\.name`/u,
    identifier: "t",
    path: "src/pages/app/store.astro",
  },
  {
    catalog: "dashboard",
    expression: "`dashboard.store_builder.template.vertical.${template.vertical}`",
    guard: /settings\.templates\.map\(\(template\) => \(\{[\s\S]*`dashboard\.store_builder\.template\.vertical\.\$\{template\.vertical\}`/u,
    identifier: "t",
    path: "src/pages/app/store.astro",
  },
] as const;

function sourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:astro|ts)$/u.test(name)) files.push({ path, source: readFileSync(path, "utf8") });
    }
  };
  walk(root);
  return files;
}

function readArgument(source: string, start: number): { end: number; text: string } {
  let quote: "'" | "`" | '"' | null = null;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (character === ")" && depth === 0) return { end: index, text: source.slice(start, index).trim() };
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 0) return { end: index, text: source.slice(start, index).trim() };
  }
  return { end: source.length, text: source.slice(start).trim() };
}

function literalKey(expression: string): string | null {
  const match = /^(?<quote>["'`])(?<key>[^"'`\r\n]*)\k<quote>$/u.exec(expression);
  const key = match?.groups?.key;
  return key === undefined || (match?.groups?.quote === "`" && key.includes("${")) ? null : key;
}

function isFunctionDeclaration(source: string, index: number): boolean {
  return /function\s*$/u.test(source.slice(Math.max(0, index - 24), index));
}

function scanIdentifierCalls(input: SourceFile, identifier: string, catalog: CatalogName, factory: string | null): TranslationReference[] {
  const references: TranslationReference[] = [];
  const pattern = new RegExp(`\\b${identifier}\\s*\\(`, "gu");
  for (const match of input.source.matchAll(pattern)) {
    const index = match.index;
    if (isFunctionDeclaration(input.source, index)) continue;
    const start = index + match[0].length;
    const argument = readArgument(input.source, start);
    references.push({ catalog, expression: argument.text, factory, identifier, index, kind: "translator", path: input.path, source: input.source });
  }
  return references;
}

function scanTranslationReferences(root: string): TranslationReference[] {
  const references: TranslationReference[] = [];
  for (const input of sourceFiles(root)) {
    const bindings = new Map<string, { catalog: CatalogName; factory: string }>();
    for (const match of input.source.matchAll(/(?:const|let|var)\s+(?<identifier>[A-Za-z_$][\w$]*)\s*=\s*create(?<factory>[A-Za-z]+)Translator\s*\(/gu)) {
      const factory = match.groups?.factory;
      const identifier = match.groups?.identifier;
      if (factory === undefined || identifier === undefined) continue;
      const catalog = FACTORY_CATALOG[factory];
      if (catalog !== undefined) bindings.set(identifier, { catalog, factory });
    }
    for (const [identifier, binding] of bindings) {
      references.push(...scanIdentifierCalls(input, identifier, binding.catalog, binding.factory));
    }

    const directPattern = /\bcreate(?<factory>[A-Za-z]+)Translator\s*\([^)]*\)\s*\(/gu;
    for (const match of input.source.matchAll(directPattern)) {
      const factory = match.groups?.factory;
      if (factory === undefined) continue;
      const catalog = FACTORY_CATALOG[factory];
      if (catalog === undefined) continue;
      const start = match.index + match[0].length;
      const argument = readArgument(input.source, start);
      references.push({ catalog, expression: argument.text, factory, identifier: `create${factory}Translator`, index: match.index, kind: "translator", path: input.path, source: input.source });
    }

    for (const match of input.source.matchAll(/\btelegramText\s*\(/gu)) {
      const index = match.index;
      if (isFunctionDeclaration(input.source, index)) continue;
      const first = readArgument(input.source, index + match[0].length);
      if (input.source[first.end] !== ",") continue;
      const second = readArgument(input.source, first.end + 1);
      references.push({ catalog: "telegram", expression: second.text, factory: null, identifier: "telegramText", index, kind: "telegram", path: input.path, source: input.source });
    }

  }
  return references;
}

function placeholders(value: string): string[] {
  return [...new Set([...value.matchAll(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu)].map((match) => match[1] ?? ""))].sort();
}

function literalCatalogKeys(source: string, catalog: CatalogName): string[] {
  const prefixes = CATALOG_KEY_PREFIXES[catalog];
  return [...new Set([...source.matchAll(/(?<quote>["'`])(?<value>[^"'`\r\n]*)\k<quote>/gu)]
    .map((match) => match.groups?.value ?? "")
    .filter((value) => !value.includes("${")
      && prefixes.some((prefix) => value.startsWith(prefix))
      && (CATALOG_GROUPS[catalog].en[value] !== undefined || CATALOG_GROUPS[catalog]["vi-VN"][value] !== undefined)))].sort();
}

function dynamicCatalogPrefix(expression: string): string | null {
  return /^`(?<prefix>[^$`]*)\$\{/u.exec(expression)?.groups?.prefix ?? null;
}

describe("translation call-site and placeholder contracts", () => {
  it("keeps every literal translator call backed by both locale catalogs", () => {
    const missing: Array<{ catalog: CatalogName; key: string; locale: "en" | "vi-VN"; path: string }> = [];
    for (const reference of scanTranslationReferences(join(process.cwd(), "src"))) {
      const key = literalKey(reference.expression);
      if (key === null) continue;
      for (const locale of ["en", "vi-VN"] as const) {
        if (CATALOG_GROUPS[reference.catalog][locale][key] === undefined) missing.push({ catalog: reference.catalog, key, locale, path: relative(process.cwd(), reference.path) });
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps English and Vietnamese placeholder names in parity", () => {
    const mismatches: Array<{ catalog: CatalogName; en: string[]; key: string; vi: string[] }> = [];
    for (const [catalog, catalogs] of Object.entries(CATALOG_GROUPS) as Array<[CatalogName, (typeof CATALOG_GROUPS)[CatalogName]]>) {
      const english = catalogs.en;
      const vietnamese = catalogs["vi-VN"];
      for (const [key, value] of Object.entries(english)) {
        const translated = vietnamese[key];
        if (translated === undefined) continue;
        const en = placeholders(value);
        const vi = placeholders(translated);
        if (JSON.stringify(en) !== JSON.stringify(vi)) mismatches.push({ catalog, en, key, vi });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("does not silently introduce unreviewed dynamic translator keys", () => {
    const unmatched: Array<{ catalog: CatalogName; expression: string; identifier: string; path: string }> = [];
    const observed = new Set<number>();
    for (const reference of scanTranslationReferences(join(process.cwd(), "src"))) {
      if (literalKey(reference.expression) !== null) continue;
      const path = relative(process.cwd(), reference.path);
      const allowlistIndex = DYNAMIC_TRANSLATION_ALLOWLIST.findIndex((entry) => entry.catalog === reference.catalog
        && entry.expression === reference.expression
        && entry.identifier === reference.identifier
        && entry.path === path);
      if (allowlistIndex < 0) {
        unmatched.push({ catalog: reference.catalog, expression: reference.expression, identifier: reference.identifier, path });
        continue;
      }
      observed.add(allowlistIndex);
      expect(reference.source, `${path}: ${reference.expression}`).toMatch(DYNAMIC_TRANSLATION_ALLOWLIST[allowlistIndex]?.guard ?? /$^/u);
      for (const key of literalCatalogKeys(reference.source, reference.catalog)) {
        for (const locale of ["en", "vi-VN"] as const) {
          expect(CATALOG_GROUPS[reference.catalog][locale][key], `${path}: ${locale}:${key}`).toBeTypeOf("string");
        }
      }
      const prefix = dynamicCatalogPrefix(reference.expression);
      if (prefix !== null) {
        for (const locale of ["en", "vi-VN"] as const) {
          expect(Object.keys(CATALOG_GROUPS[reference.catalog][locale]).some((key) => key.startsWith(prefix)), `${path}: ${locale}:${prefix}*`).toBe(true);
        }
      }
    }
    expect(unmatched).toEqual([]);
    expect(DYNAMIC_TRANSLATION_ALLOWLIST.map((_, index) => index).filter((index) => !observed.has(index))).toEqual([]);
  });
});
