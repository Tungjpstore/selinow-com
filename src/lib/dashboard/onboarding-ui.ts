import { parseMajorAmountToMinor } from "../i18n/currency";

export const WIZARD_STEPS = [
  { code: "shop", label: "Store", labelKey: "onboarding.step.shop", number: "01" },
  { code: "channels", label: "Sales channels", labelKey: "onboarding.step.channels", number: "02" },
  { code: "catalog", label: "Products", labelKey: "onboarding.step.catalog", number: "03" },
  { code: "inventory", label: "License inventory", labelKey: "onboarding.step.inventory", number: "04" },
  { code: "telegram", label: "Telegram", labelKey: "onboarding.step.telegram", number: "05" },
  { code: "payos", label: "PayOS", labelKey: "onboarding.step.payos", number: "06" },
  { code: "settings", label: "Information", labelKey: "onboarding.step.settings", number: "07" },
  { code: "readiness", label: "Checks", labelKey: "onboarding.step.readiness", number: "08" },
] as const;

export type WizardStepCode = typeof WIZARD_STEPS[number]["code"];
export type WizardStepStatus = "blocked" | "in_progress" | "not_started" | "ready" | "warning";

export type OnboardingProfileView = {
  customDomainPreference: "connect" | "later" | "skip";
  telegramEnabled: boolean;
  websiteEnabled: boolean;
};

export type OnboardingSettingsView = {
  attestationAccepted: boolean;
  privacyUrl: string;
  refundPolicyUrl: string;
  supportContact: string;
  termsUrl: string;
  /** Server-owned shop_settings version; draft forms may not have one yet. */
  version?: number;
};

export type ReadinessCheckView = {
  actionUrl: string | null;
  checkedAt: string | null;
  code: string;
  messageKey: string;
  required: boolean;
  status: "fail" | "pass" | "warning";
};

export type OnboardingSnapshot = {
  profile: OnboardingProfileView | null;
  settings: OnboardingSettingsView | null;
  steps: Map<string, WizardStepStatus>;
};

export type InventoryDraftSummary = {
  acceptedCount: number;
  duplicateCount: number;
  invalidCount: number;
  totalCount: number;
};

export type ControlledTestOrderView = {
  checkedAt: string | null;
  domainReady: boolean;
  inventory: {
    availableCount: number | null;
    code: string;
    currency: string | null;
    productTitle: string | null;
    quantity: number;
    sufficient: boolean;
    totalMinor: number | null;
    variantTitle: string | null;
  };
  passed: boolean;
  payosConfigured: boolean;
  payosReady: boolean;
  readinessReady: boolean;
  telegramConfigured: boolean;
  telegramReady: boolean;
};

export type FallbackProgressInput = {
  activeProductCount: number;
  availableInventoryCount: number;
  hasManualProduct: boolean;
  payosReady: boolean;
  profile: OnboardingProfileView | null;
  readinessReady: boolean;
  settingsReady: boolean;
  shopExists: boolean;
  shopPublished: boolean;
  telegramHealthReady: boolean;
  telegramReady: boolean;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function safeStepStatus(value: unknown): WizardStepStatus | null {
  switch (value) {
    case "blocked": return "blocked";
    case "complete":
    case "ready": return "ready";
    case "in_progress": return "in_progress";
    case "not_started":
    case "pending": return "not_started";
    case "skipped":
    case "warning": return "warning";
    default: return null;
  }
}

export function parseOnboardingSnapshot(value: unknown): OnboardingSnapshot {
  const root = recordOf(value) ?? {};
  const profileRecord = recordOf(root.profile);
  const settingsRecord = recordOf(root.settings);
  const preference = profileRecord?.customDomainPreference;
  const profile: OnboardingProfileView | null = profileRecord === null ? null : {
    customDomainPreference: preference === "connect" || preference === "skip" ? preference : "later",
    telegramEnabled: booleanValue(profileRecord.telegramEnabled),
    websiteEnabled: booleanValue(profileRecord.websiteEnabled),
  };
  const settingsVersion = typeof settingsRecord?.version === "number"
    && Number.isSafeInteger(settingsRecord.version)
    && settingsRecord.version >= 1
    ? settingsRecord.version
    : undefined;
  const settings = settingsRecord === null ? null : {
    attestationAccepted: booleanValue(settingsRecord.attestationAccepted),
    privacyUrl: stringValue(settingsRecord.privacyUrl),
    refundPolicyUrl: stringValue(settingsRecord.refundPolicyUrl),
    supportContact: stringValue(settingsRecord.supportContact),
    termsUrl: stringValue(settingsRecord.termsUrl),
    ...(settingsVersion === undefined ? {} : { version: settingsVersion }),
  };
  const steps = new Map<string, WizardStepStatus>();
  if (Array.isArray(root.steps)) {
    for (const item of root.steps) {
      const row = recordOf(item);
      if (row === null) continue;
      const code = typeof row.code === "string" ? row.code : typeof row.stepCode === "string" ? row.stepCode : null;
      const status = safeStepStatus(row.status);
      if (code !== null && status !== null) steps.set(code, status);
    }
  }
  return { profile, settings, steps };
}

export function parseReadinessChecks(value: unknown): { checkedAt: string | null; checks: ReadinessCheckView[]; ready: boolean; runId: string | null } {
  const root = recordOf(value) ?? {};
  const run = recordOf(root.run) ?? root;
  const checks: ReadinessCheckView[] = [];
  if (Array.isArray(run.checks)) {
    for (const item of run.checks) {
      const row = recordOf(item);
      if (row === null || typeof row.code !== "string") continue;
      const status = row.status === "pass" || row.status === "warning" ? row.status : "fail";
      checks.push({
        actionUrl: typeof row.actionUrl === "string" ? row.actionUrl : null,
        checkedAt: typeof row.checkedAt === "string" ? row.checkedAt : null,
        code: row.code,
        messageKey: typeof row.messageKey === "string" ? row.messageKey : row.code,
        required: row.required !== false,
        status,
      });
    }
  }
  return {
    checkedAt: typeof run.checkedAt === "string" ? run.checkedAt : null,
    checks,
    ready: run.ready === true,
    runId: typeof run.runId === "string" ? run.runId : null,
  };
}

export function parseControlledTestOrder(value: unknown): ControlledTestOrderView | null {
  const root = recordOf(value) ?? {};
  const testOrder = recordOf(root.testOrder);
  const domainHealth = recordOf(testOrder?.domainHealth);
  const inventory = recordOf(testOrder?.inventoryDryRun);
  const providerHealth = recordOf(testOrder?.providerHealth);
  const payos = recordOf(providerHealth?.payos);
  const telegram = recordOf(providerHealth?.telegram);
  const readiness = recordOf(testOrder?.readiness);
  if (testOrder === null || domainHealth === null || inventory === null || payos === null || telegram === null || readiness === null) return null;
  const quantity = nullableNumber(inventory.quantity);
  if (quantity === null || quantity < 1 || typeof inventory.code !== "string") return null;
  return {
    checkedAt: typeof testOrder.checkedAt === "string" ? testOrder.checkedAt : null,
    domainReady: booleanValue(domainHealth.ready),
    inventory: {
      availableCount: nullableNumber(inventory.availableCount),
      code: inventory.code,
      currency: typeof inventory.currency === "string" ? inventory.currency : null,
      productTitle: typeof inventory.productTitle === "string" ? inventory.productTitle : null,
      quantity,
      sufficient: booleanValue(inventory.sufficient),
      totalMinor: nullableNumber(inventory.totalMinor),
      variantTitle: typeof inventory.variantTitle === "string" ? inventory.variantTitle : null,
    },
    passed: booleanValue(testOrder.passed),
    payosConfigured: booleanValue(payos.configured),
    payosReady: booleanValue(payos.ready),
    readinessReady: booleanValue(readiness.ready),
    telegramConfigured: booleanValue(telegram.configured),
    telegramReady: booleanValue(telegram.ready),
  };
}

export function deriveFallbackProgress(input: FallbackProgressInput): Record<WizardStepCode, WizardStepStatus> {
  const channelReady = input.profile !== null && (input.profile.telegramEnabled || input.profile.websiteEnabled);
  const catalogReady = input.activeProductCount > 0;
  const inventoryReady = catalogReady && (input.availableInventoryCount > 0 || input.hasManualProduct);
  const telegramRequired = input.profile?.telegramEnabled === true;
  const telegramReady = !telegramRequired || (input.telegramReady && input.telegramHealthReady);
  return {
    catalog: catalogReady ? "ready" : input.shopExists ? "in_progress" : "blocked",
    channels: channelReady ? "ready" : input.shopExists ? "in_progress" : "blocked",
    inventory: inventoryReady ? "ready" : catalogReady ? "in_progress" : "blocked",
    payos: input.payosReady ? "ready" : input.shopExists ? "in_progress" : "blocked",
    readiness: input.readinessReady || input.shopPublished ? "ready" : inventoryReady && input.payosReady && telegramReady && input.settingsReady ? "in_progress" : "blocked",
    settings: input.settingsReady ? "ready" : input.shopExists ? "in_progress" : "blocked",
    shop: input.shopExists ? "ready" : "in_progress",
    telegram: telegramRequired ? (telegramReady ? "ready" : "in_progress") : "warning",
  };
}

export function hasAuthoritativeTelegramHealth(lastHealthUpdateAt: string | null): boolean {
  return lastHealthUpdateAt !== null;
}

export function mergeServerProgress(
  fallback: Record<WizardStepCode, WizardStepStatus>,
  serverSteps: ReadonlyMap<string, WizardStepStatus>,
): Record<WizardStepCode, WizardStepStatus> {
  const aliases: Record<WizardStepCode, readonly string[]> = {
    catalog: ["catalog", "catalog_ready"],
    channels: ["channels", "channel_selected"],
    inventory: ["inventory", "inventory_ready"],
    payos: ["payos", "payos_ready"],
    readiness: ["readiness", "readiness_passed", "published"],
    settings: ["settings", "policies_ready"],
    shop: ["shop", "account_ready", "shop_created"],
    telegram: ["telegram", "telegram_ready"],
  };
  const result = { ...fallback };
  for (const step of WIZARD_STEPS) {
    for (const alias of aliases[step.code]) {
      const status = serverSteps.get(alias);
      if (status !== undefined) {
        result[step.code] = status;
        break;
      }
    }
  }
  return result;
}

export function progressPercent(progress: Record<WizardStepCode, WizardStepStatus>): number {
  const ready = WIZARD_STEPS.filter((step) => progress[step.code] === "ready" || progress[step.code] === "warning").length;
  return Math.round((ready / WIZARD_STEPS.length) * 100);
}

export function validateShopDraft(nameValue: string, slugValue: string): { name: string; slug: string } | null {
  const name = nameValue.trim().replace(/\s+/gu, " ");
  const slug = slugValue.trim().toLowerCase();
  if (name.length < 2 || name.length > 80) return null;
  if (slug.length < 3 || slug.length > 48 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u.test(slug) || slug.includes("--")) return null;
  return { name, slug };
}

export function slugifyDraft(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 48);
}

export function validateProductDraft(input: {
  currency?: string;
  description: string;
  fulfillmentType: string;
  priceMajor?: string;
  priceMinor?: string;
  productSlug: string;
  sku: string;
  title: string;
  variantTitle: string;
}): { description: string; fulfillmentType: "license_key" | "manual"; priceMinor: number; productSlug: string; sku: string; title: string; variantTitle: string } | null {
  const title = input.title.trim().replace(/\s+/gu, " ");
  const variantTitle = input.variantTitle.trim().replace(/\s+/gu, " ");
  const productSlug = input.productSlug.trim().toLowerCase();
  const sku = input.sku.trim().toUpperCase();
  const priceValue = input.priceMajor ?? input.priceMinor ?? "";
  const priceMinor = input.currency === undefined
    ? Number(priceValue)
    : parseMajorAmountToMinor(priceValue, input.currency);
  if (title.length < 2 || title.length > 120 || variantTitle.length < 2 || variantTitle.length > 120) return null;
  if (input.description.length > 10_000) return null;
  if (productSlug.length < 2 || productSlug.length > 80 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u.test(productSlug) || productSlug.includes("--")) return null;
  if (sku.length < 1 || sku.length > 64 || !/^[A-Z0-9][A-Z0-9._-]*$/u.test(sku)) return null;
  if (priceMinor === null || !Number.isSafeInteger(priceMinor) || priceMinor < 0 || priceMinor > 9_000_000_000_000) return null;
  if (input.fulfillmentType !== "license_key" && input.fulfillmentType !== "manual") return null;
  return { description: input.description.trim(), fulfillmentType: input.fulfillmentType, priceMinor, productSlug, sku, title, variantTitle };
}

export function summarizeInventoryDraft(value: string, source: "csv" | "paste"): InventoryDraftSummary {
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const seen = new Set<string>();
  let acceptedCount = 0;
  let duplicateCount = 0;
  let invalidCount = 0;
  let totalCount = 0;
  for (const line of lines) {
    const key = (source === "csv" ? line.split(",", 1)[0] ?? "" : line).trim();
    if (key.length === 0) continue;
    totalCount += 1;
    const byteLength = new TextEncoder().encode(key).byteLength;
    const hasControl = Array.from(key).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    if (key.length > 1_024 || byteLength > 2_048 || hasControl) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    acceptedCount += 1;
  }
  return { acceptedCount, duplicateCount, invalidCount, totalCount };
}

export function isSafeHttpsUrl(value: string): boolean {
  if (value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}

export function settingsDraftReady(input: OnboardingSettingsView): boolean {
  return input.attestationAccepted
    && input.supportContact.trim().length >= 3
    && input.supportContact.trim().length <= 180
    && [input.termsUrl, input.privacyUrl, input.refundPolicyUrl].every(isSafeHttpsUrl);
}

export function readableError(code: string, issues: readonly string[] = []): string {
  const issueMessages: Record<string, string> = {
    active_variant_required: "Hay tao it nhat mot phien ban san pham dang hoat dong.",
    bot_token_invalid: "Token Telegram chua dung dinh dang BotFather.",
    custom_domain_not_in_plan: "Goi hien tai chua bat ten mien rieng.",
    idempotency_key_invalid: "Phien tao shop da het han. Tai lai trang va thu lai.",
    inventory_count_invalid: "Nhap tu 1 den 1.000 key moi lan.",
    inventory_key_invalid: "Mot hoac nhieu key vuot gioi han cho phep.",
    plan_invalid: "Goi dich vu khong hop le.",
    publishable_product_required: "Can it nhat mot san pham co the ban truoc khi publish.",
    slug_reserved: "Slug nay duoc danh rieng cho he thong.",
  };
  for (const issue of issues) {
    const issueMessage = issueMessages[issue];
    if (issueMessage !== undefined) return issueMessage;
  }
  const messages: Record<string, string> = {
    authentication_required: "Phien dang nhap da het han. Hay dang nhap lai.",
    authorization_denied: "Tai khoan nay khong co quyen thuc hien buoc nay.",
    catalog_conflict: "Slug hoac SKU da ton tai. Wizard se tai lai du lieu de ban tiep tuc.",
    credential_duplicate: "Thong tin ket noi nay da duoc gui truoc do. Hay lam moi trang thai.",
    csrf_invalid: "Phien bao mat khong con hop le. Tai lai trang roi thu lai.",
    idempotency_conflict: "Yeu cau cu da duoc dung cho noi dung khac. Hay thu lai.",
    inventory_duplicate: "Danh sach co key trung voi kho hoac trung trong chinh tep.",
    inventory_preview_expired: "Preview da het han. Hay tao preview moi truoc khi import.",
    inventory_preview_invalid: "Preview khong hop le. Hay tao preview moi truoc khi import.",
    inventory_preview_mismatch: "Noi dung hoac variant da thay doi. Hay tao preview moi.",
    provider_unavailable: "Nha cung cap dang ban. Du lieu da nhap khong duoc hien thi lai; hay thu lai sau.",
    payment_not_configured: "Hay ket noi PayOS truoc khi kiem tra lai webhook.",
    recent_auth_required: "Hay dang nhap lai truoc khi ket noi credential.",
    request_failed: "Yeu cau chua hoan tat. Kiem tra mang va thu lai.",
    subscription_required: "Goi hien tai khong cho phep thao tac nay.",
    validation_failed: "Kiem tra lai cac truong vua nhap.",
  };
  return messages[code] ?? "Yeu cau chua hoan tat. Hay thu lai.";
}

/** Select a catalog key without exposing provider text or internal error data. */
export function readableErrorKey(code: string, issues: readonly string[] = []): string {
  const knownIssues = new Set([
    "active_variant_required",
    "bot_token_invalid",
    "custom_domain_not_in_plan",
    "idempotency_key_invalid",
    "inventory_count_invalid",
    "inventory_key_invalid",
    "plan_invalid",
    "publishable_product_required",
    "slug_reserved",
    "slug_unavailable",
    "trial_already_used",
  ]);
  for (const issue of issues) {
    if (knownIssues.has(issue)) return `onboarding.error.issue.${issue}`;
  }
  const knownCodes = new Set([
    "authentication_required",
    "authorization_denied",
    "catalog_conflict",
    "credential_duplicate",
    "csrf_invalid",
    "idempotency_conflict",
    "inventory_duplicate",
    "inventory_preview_expired",
    "inventory_preview_invalid",
    "inventory_preview_mismatch",
    "provider_unavailable",
    "payment_not_configured",
    "recent_auth_required",
    "request_failed",
    "subscription_required",
    "validation_failed",
  ]);
  return knownCodes.has(code) ? `onboarding.error.code.${code}` : "onboarding.error.generic";
}
