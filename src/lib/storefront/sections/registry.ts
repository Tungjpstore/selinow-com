/**
 * TM0 — Storefront section registry: the home page becomes an ordered stack of
 * typed sections persisted inside `shop_settings.storefront_json.sections`
 * (additive JSON, no migration). Every parse is bounded and degrades to the
 * template's default stack, so an unknown/garbage config can never break the
 * storefront. Section TYPES here mirror what the templates actually render
 * today; TM1+ turns more of them into configurable, reorderable components.
 */

export type StorefrontSectionType =
  | "hero"
  | "trust"
  | "menu"
  | "plan"
  | "steps"
  | "catalog"
  | "services"
  | "process"
  | "categories"
  | "voucher"
  | "bento"
  | "collection_rail"
  | "editorial_split"
  | "spec_grid"
  | "flash_rail"
  | "stock_grid"
  | "gallery_wall"
  | "masters_row"
  | "ritual_steps"
  | "gift_card"
  | "testimonials"
  | "booking_cta"
  | "calculator"
  | "hours_band"
  | "newsletter"
  | "usp"
  | "faq"
  | "rich_footer";

export type StorefrontSectionConfig = {
  enabled: boolean;
  id: string;
  settings: Record<string, unknown>;
  type: StorefrontSectionType;
};

const SECTION_TYPES: ReadonlySet<string> = new Set<StorefrontSectionType>([
  "hero", "trust", "menu", "plan", "steps", "catalog", "services", "process", "categories",
  "voucher", "bento", "collection_rail", "editorial_split", "spec_grid", "flash_rail",
  "stock_grid", "gallery_wall", "masters_row", "ritual_steps", "gift_card", "testimonials",
  "booking_cta", "calculator", "hours_band", "newsletter", "usp", "faq", "rich_footer",
]);

const MAX_SECTIONS = 12;

/**
 * Default stacks describe what each template renders today (native blocks)
 * plus the universal USP + FAQ sections TM0 appends. TM1 lets merchants
 * reorder/toggle within these bounds.
 */
export const DEFAULT_HOME_STACKS: Readonly<Record<string, readonly StorefrontSectionType[]>> = {
  aurora: ["hero", "categories", "catalog", "usp", "faq"],
  bustle: ["hero", "voucher", "catalog", "usp", "faq"],
  clinic: ["hero", "services", "process", "categories", "usp", "faq"],
  craft: ["hero", "services", "steps", "categories", "usp", "faq"],
  desk: ["hero", "plan", "steps", "catalog", "usp", "faq"],
  metro: ["hero", "trust", "catalog", "usp", "faq"],
  pulse: ["hero", "trust", "catalog", "usp", "faq"],
  serenity: ["hero", "services", "categories", "usp", "faq"],
  swift: ["hero", "catalog", "usp", "faq"],
};

export function defaultHomeStack(templateId: string): readonly StorefrontSectionType[] {
  return DEFAULT_HOME_STACKS[templateId] ?? DEFAULT_HOME_STACKS.swift ?? [];
}

const MAX_SETTING_ITEMS = 8;

function parseScalar(entry: unknown): string | number | boolean | null | undefined {
  if (typeof entry === "string") return entry.slice(0, 300);
  if (typeof entry === "number" || typeof entry === "boolean" || entry === null) return entry;
  return undefined;
}

function parseSettings(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const settings: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
    if (key.length > 32) continue;
    // TM2: one bounded array-of-records level carries section item lists
    // (usp/faq items) through the same cleaning as scalars.
    if (Array.isArray(entry)) {
      const items: Array<Record<string, string | number | boolean | null>> = [];
      for (const item of entry.slice(0, MAX_SETTING_ITEMS)) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const record: Record<string, string | number | boolean | null> = {};
        for (const [itemKey, itemValue] of Object.entries(item as Record<string, unknown>).slice(0, 6)) {
          if (itemKey.length > 24) continue;
          const scalar = parseScalar(itemValue);
          if (scalar !== undefined) record[itemKey] = scalar;
        }
        if (Object.keys(record).length > 0) items.push(record);
      }
      if (items.length > 0) settings[key] = items;
      continue;
    }
    const scalar = parseScalar(entry);
    if (scalar !== undefined) settings[key] = scalar;
  }
  return settings;
}

/**
 * Parse the persisted `sections` array. Unknown types/ids and oversized stacks
 * are dropped or truncated — the result is always a valid, enabled-only stack;
 * an empty result signals "use the template default stack" instead.
 */
export function parseHomeSections(value: unknown): StorefrontSectionConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const parsed: StorefrontSectionConfig[] = [];
  for (const entry of value.slice(0, MAX_SECTIONS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    const id = record.id;
    if (typeof type !== "string" || !SECTION_TYPES.has(type)) continue;
    if (typeof id !== "string" || id.length === 0 || id.length > 40 || seen.has(id)) continue;
    seen.add(id);
    parsed.push({
      enabled: record.enabled !== false,
      id,
      settings: parseSettings(record.settings),
      type: type as StorefrontSectionType,
    });
  }
  return parsed;
}

/** Render-time resolution: persisted config or the template default. */
export function resolveHomeSections(templateId: string, persisted: StorefrontSectionConfig[]): readonly StorefrontSectionType[] {
  if (persisted.length === 0) return defaultHomeStack(templateId);
  return persisted.filter((section) => section.enabled).map((section) => section.type);
}

/**
 * TM1 render semantics: the persisted array is authoritative for the
 * UNIVERSAL tail sections only (usp/faq today, testimonials etc. later);
 * native blocks always render in template order, so a partial or legacy
 * config can never drop the hero/catalog. Unknown tail types are ignored
 * until their renderer ships.
 */
const UNIVERSAL_SECTIONS: readonly StorefrontSectionType[] = ["usp", "faq"];

export function resolveUniversalSections(templateId: string, persisted: StorefrontSectionConfig[]): readonly StorefrontSectionType[] {
  const mentioned = persisted
    .filter((section) => (UNIVERSAL_SECTIONS as readonly string[]).includes(section.type) && section.enabled)
    .map((section) => section.type);
  if (mentioned.length === 0) return defaultHomeStack(templateId).filter((type) => (UNIVERSAL_SECTIONS as readonly string[]).includes(type));
  return mentioned;
}

/** Settings for a universal section type, cleaned at parse time. */
export function universalSectionSettings(persisted: StorefrontSectionConfig[], type: StorefrontSectionType): Record<string, unknown> {
  const match = persisted.find((section) => section.type === type);
  return match?.settings ?? {};
}

/** Bounded typed view over section item lists (usp/faq items). */
export type SectionItem = { body?: string; q?: string; a?: string; title?: string };

export function parseSectionItems(value: unknown, max = 3): SectionItem[] {
  if (!Array.isArray(value)) return [];
  const items: SectionItem[] = [];
  for (const entry of value.slice(0, max)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const item: SectionItem = {};
    if (typeof record.title === "string" && record.title.trim().length > 0) item.title = record.title.slice(0, 80);
    if (typeof record.body === "string" && record.body.trim().length > 0) item.body = record.body.slice(0, 240);
    if (typeof record.q === "string" && record.q.trim().length > 0) item.q = record.q.slice(0, 160);
    if (typeof record.a === "string" && record.a.trim().length > 0) item.a = record.a.slice(0, 400);
    if (Object.keys(item).length > 0) items.push(item);
  }
  return items;
}