/**
 * Storefront template registry (code-defined, no DB).
 *
 * A template is a named storefront presentation for one selling vertical
 * (digital keys, physical goods, appointment booking). The seller persists a
 * `templateId` inside `shop_settings.storefront_json`; rendering resolves it
 * through this registry so an unknown, unavailable, or no-longer-entitled id
 * always falls back to a safe default instead of breaking the storefront.
 *
 * Keep this module dependency-free: the seller dashboard client bundle may
 * import it for gallery parity with server-side validation.
 */

export type StorefrontVertical = "digital" | "physical" | "booking";
export type StorefrontTemplateScheme = "light" | "dark";

export type StorefrontTemplateDefinition = {
  /** Registry id persisted in shop_settings.storefront_json.templateId. */
  id: string;
  /** Stable Latin display name; localized copy lives in the i18n catalogs. */
  name: string;
  vertical: StorefrontVertical;
  /** Premium templates require the plan feature flag to select and render. */
  premium: boolean;
  /** Document-level scheme hint exposed as data-template-scheme. */
  scheme: StorefrontTemplateScheme;
  /**
   * False while the template's vertical is not selectable yet (roadmap
   * gating). Flips to true in the milestone that ships its components.
   */
  available: boolean;
};

/** plans.feature_flags_json flag granting access to premium templates. */
export const PREMIUM_STOREFRONT_TEMPLATES_FEATURE = "premiumStorefrontTemplates";

/** Universal render fallback; must stay available and non-premium. */
export const FALLBACK_STOREFRONT_TEMPLATE_ID = "swift";

export const STOREFRONT_TEMPLATES: readonly StorefrontTemplateDefinition[] = [
  {
    available: true,
    id: "swift",
    name: "Swift",
    premium: false,
    scheme: "light",
    vertical: "digital",
  },
  {
    available: true,
    id: "pulse",
    name: "Pulse",
    premium: true,
    scheme: "dark",
    vertical: "digital",
  },
  {
    available: true,
    id: "desk",
    name: "Desk",
    premium: true,
    scheme: "light",
    vertical: "digital",
  },
  {
    available: true,
    id: "aurora",
    name: "Aurora",
    premium: false,
    scheme: "light",
    vertical: "physical",
  },
  {
    available: true,
    id: "metro",
    name: "Metro",
    premium: true,
    scheme: "light",
    vertical: "physical",
  },
  {
    available: true,
    id: "bustle",
    name: "Bustle",
    premium: true,
    scheme: "light",
    vertical: "physical",
  },
  {
    available: true,
    id: "serenity",
    name: "Serenity",
    premium: false,
    scheme: "light",
    vertical: "booking",
  },
  {
    available: true,
    id: "craft",
    name: "Craft",
    premium: true,
    scheme: "dark",
    vertical: "booking",
  },
  {
    available: true,
    id: "clinic",
    name: "Clinic",
    premium: true,
    scheme: "light",
    vertical: "booking",
  },
];

export const STOREFRONT_TEMPLATE_IDS: readonly string[] = STOREFRONT_TEMPLATES.map((template) => template.id);

const TEMPLATES_BY_ID: ReadonlyMap<string, StorefrontTemplateDefinition> = new Map(
  STOREFRONT_TEMPLATES.map((template) => [template.id, template] as const),
);

/** Resolved fallback definition; safe to spread into StorefrontShop literals. */
export const FALLBACK_STOREFRONT_TEMPLATE: StorefrontTemplateDefinition = (() => {
  const fallback = TEMPLATES_BY_ID.get(FALLBACK_STOREFRONT_TEMPLATE_ID) ?? STOREFRONT_TEMPLATES[0];
  if (fallback === undefined) throw new Error("storefront_template_registry_empty");
  return fallback;
})();

export function getStorefrontTemplate(id: string): StorefrontTemplateDefinition | null {
  return TEMPLATES_BY_ID.get(id) ?? null;
}

/** Gallery copy in registry order; callers layer entitlement on top. */
export function listStorefrontTemplates(): readonly StorefrontTemplateDefinition[] {
  return STOREFRONT_TEMPLATES;
}

export function defaultStorefrontTemplateFor(vertical: StorefrontVertical): StorefrontTemplateDefinition {
  const template = STOREFRONT_TEMPLATES.find((candidate) => candidate.vertical === vertical && !candidate.premium && candidate.available);
  if (template === undefined) throw new Error(`storefront_template_default_missing:${vertical}`);
  return template;
}

/**
 * Validate a persisted (untrusted) template selection for rendering.
 * Unknown, unavailable, or premium-without-entitlement ids resolve to the
 * safe fallback so the storefront never fails to render.
 */
export function resolveStorefrontTemplate(input: { premiumEntitled: boolean; templateId: unknown }): StorefrontTemplateDefinition {
  if (typeof input.templateId === "string") {
    const template = getStorefrontTemplate(input.templateId);
    if (template !== null && template.available && (!template.premium || input.premiumEntitled)) return template;
  }
  return FALLBACK_STOREFRONT_TEMPLATE;
}

export type StorefrontTemplateSelectionIssue = "storefront_template_invalid" | "storefront_template_premium_required";

/**
 * Validate a seller-initiated template selection (strict, unlike the lenient
 * render fallback). Returns the entitlement issue instead of throwing so the
 * settings layer can map it to its error contract.
 */
export function storefrontTemplateSelectionIssue(input: {
  premiumEntitled: boolean;
  templateId: unknown;
}): StorefrontTemplateDefinition | StorefrontTemplateSelectionIssue {
  if (typeof input.templateId !== "string") return "storefront_template_invalid";
  const template = getStorefrontTemplate(input.templateId);
  if (template === null || !template.available) return "storefront_template_invalid";
  if (template.premium && !input.premiumEntitled) return "storefront_template_premium_required";
  return template;
}

/**
 * ── Selling category (danh mục kinh doanh) ──────────────────────────────
 *
 * The friendly, business-facing layer over `StorefrontVertical`. A seller
 * picks a category ("Phần mềm & Key bản quyền") and it maps to the vertical
 * whose templates + onboarding presets are relevant. Kept in one place so the
 * onboarding gallery, the store builder template tab, and server-side
 * validation all agree on the same mapping.
 */
export type StorefrontCategoryId = "software" | "physical" | "service";

export type StorefrontCategory = {
  id: StorefrontCategoryId;
  vertical: StorefrontVertical;
  /** Icon key resolved by the dashboard `<Icon name=...>` component. */
  icon: string;
};

export const STOREFRONT_CATEGORIES: readonly StorefrontCategory[] = [
  { id: "software", vertical: "digital", icon: "zap" },
  { id: "physical", vertical: "physical", icon: "box" },
  { id: "service", vertical: "booking", icon: "calendar" },
];

const CATEGORIES_BY_ID: ReadonlyMap<StorefrontCategoryId, StorefrontCategory> = new Map(
  STOREFRONT_CATEGORIES.map((category) => [category.id, category] as const),
);

export function getStorefrontCategory(id: StorefrontCategoryId): StorefrontCategory {
  const category = CATEGORIES_BY_ID.get(id);
  if (category === undefined) throw new Error(`storefront_category_unknown:${id}`);
  return category;
}

/** Templates relevant to a selling category (filters by the mapped vertical). */
export function templatesForCategory(categoryId: StorefrontCategoryId): readonly StorefrontTemplateDefinition[] {
  const vertical = getStorefrontCategory(categoryId).vertical;
  return STOREFRONT_TEMPLATES.filter((template) => template.vertical === vertical);
}

/** First non-premium available template for a category (safe gallery default). */
export function defaultTemplateForCategory(categoryId: StorefrontCategoryId): StorefrontTemplateDefinition {
  const vertical = getStorefrontCategory(categoryId).vertical;
  return defaultStorefrontTemplateFor(vertical);
}
