import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { parseStorefrontContent } from "../../src/lib/storefront/theme";
import { defaultHomeStack, parseSectionItems, resolveUniversalSections } from "../../src/lib/storefront/sections/registry";
import { getSellerStorefrontSettings, updateSellerStorefrontSettings } from "../../src/lib/tenants/storefront-settings";

/** TM1 — sections persist through the seller settings draft and drive the
 * universal tail on every template home. */

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  const now = "2026-08-22T00:00:00.000Z";
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES ('user-a', 'a@example.test', 'Owner A', 'active', ?, ?)").run(now, now);
  database.prepare(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-a', 'public-a', 'seller-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(now, now);
  database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-a', 'user-a', 'owner', 'active', ?, ?)").run(now, now);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES ('sub-a', 'shop-a', 'plan_business_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)").run(now, now);
  database.prepare("INSERT INTO shop_settings (shop_id, branding_json, storefront_json, version, updated_at) VALUES ('shop-a', '{}', '{}', 1, ?)").run(now);
  const env = { PLATFORM_DB: new SqliteD1(database) as unknown as D1Database } as unknown as AppBindings;
  return { database, env };
}

describe("TM1 universal-section resolution", () => {
  it("keeps the default tail when nothing is persisted and obeys persisted order", () => {
    expect(resolveUniversalSections("pulse", [])).toEqual(["usp", "faq"]);
    expect(resolveUniversalSections("swift", [
      { enabled: true, id: "cfg-faq", settings: {}, type: "faq" },
      { enabled: false, id: "cfg-usp", settings: {}, type: "usp" },
    ])).toEqual(["faq"]);
    expect(resolveUniversalSections("clinic", [
      { enabled: true, id: "cfg-faq", settings: {}, type: "faq" },
      { enabled: true, id: "cfg-usp", settings: {}, type: "usp" },
    ])).toEqual(["faq", "usp"]);
    // A config that disables everything still cannot drop the tail default.
    expect(resolveUniversalSections("metro", [
      { enabled: false, id: "cfg-usp", settings: {}, type: "usp" },
      { enabled: false, id: "cfg-faq", settings: {}, type: "faq" },
    ])).toEqual(defaultHomeStack("metro").filter((type) => type === "usp" || type === "faq"));
  });
});

describe("TM1 sections persistence through the seller settings draft", () => {
  it("cleans and persists the sections array, then surfaces it on read", async () => {
    const { database, env } = setup();
    const updated = await updateSellerStorefrontSettings({
      data: {
        sections: [
          { enabled: true, id: "cfg-faq", settings: {}, type: "faq" },
          { enabled: true, id: "cfg-bogus", settings: {}, type: "not_real" },
          { enabled: true, id: "cfg-usp", settings: { tone: "bold" }, type: "usp" },
        ],
      },
      env,
      expectedVersion: 1,
      shopPublicId: "public-a",
      userId: "user-a",
    });
    expect(updated.content.sections?.map((section) => section.type)).toEqual(["faq", "usp"]);
    const draftRow = database.prepare("SELECT storefront_json AS json FROM shop_settings WHERE shop_id = 'shop-a'").get() as { json: string };
    const draft = JSON.parse(draftRow.json) as { sections?: Array<{ type: string }> };
    expect(draft.sections?.map((section) => section.type)).toEqual(["faq", "usp"]);

    const settings = await getSellerStorefrontSettings({ env, shopPublicId: "public-a", userId: "user-a" });
    expect(settings.content.sections).toHaveLength(2);
    expect(parseStorefrontContent(draftRow.json, "Shop A").sections?.[1]?.settings).toEqual({ tone: "bold" });
  });

  it("stores an empty array as absent so the template default applies", async () => {
    const { database, env } = setup();
    database.prepare("UPDATE shop_settings SET storefront_json = ? WHERE shop_id = 'shop-a'")
      .run(JSON.stringify({ sections: [{ enabled: true, id: "cfg-usp", settings: {}, type: "usp" }] }));
    await updateSellerStorefrontSettings({
      data: { sections: [] },
      env,
      expectedVersion: 1,
      shopPublicId: "public-a",
      userId: "user-a",
    });
    const draftRow = database.prepare("SELECT storefront_json AS json FROM shop_settings WHERE shop_id = 'shop-a'").get() as { json: string };
    expect((JSON.parse(draftRow.json) as Record<string, unknown>).sections).toBeUndefined();
  });
});

describe("TM2 merchant-edited section items", () => {
  it("carries bounded item arrays through parseSettings and surfaces them", () => {
    const content = parseStorefrontContent(JSON.stringify({
      sections: [{
        enabled: true,
        id: "cfg-usp",
        settings: {
          items: [
            { body: "Giao trong 24h", title: "Ship nhanh" },
            "garbage",
            { body: "", title: "   " },
          ],
        },
        type: "usp",
      }],
    }), "Shop A");
    const uspSettings = content.sections?.[0]?.settings as { items?: Array<Record<string, string>> };
    // parseSettings keeps any scalar record (general cleaner); the render-side
    // parseSectionItems is what drops blank entries.
    expect(uspSettings.items).toEqual([{ body: "Giao trong 24h", title: "Ship nhanh" }, { body: "", title: "   " }]);
    expect(parseSectionItems(uspSettings.items)).toEqual([{ body: "Giao trong 24h", title: "Ship nhanh" }]);
  });

  it("caps item arrays at eight entries and drops malformed records", () => {
    const flood = Array.from({ length: 20 }, (_, index) => ({ title: `T${String(index)}` }));
    const content = parseStorefrontContent(JSON.stringify({
      sections: [{ enabled: true, id: "cfg-faq", settings: { items: flood }, type: "faq" }],
    }), "Shop A");
    const faqSettings = content.sections?.[0]?.settings as { items?: Array<Record<string, string>> };
    expect(faqSettings.items).toHaveLength(8);
  });

  it("ships item edit inputs wired into the sections JSON", () => {
    const store = readFileSync("src/pages/app/store.astro", "utf8");
    expect(store).toContain('data-section-item="usp"');
    expect(store).toContain('data-section-item="faq"');
    expect(store).toContain('data-section-item-field="title"');
    expect(store).toContain('data-section-item-field="q"');
    const builder = readFileSync("src/scripts/dashboard/store-builder.ts", "utf8");
    expect(builder).toContain("readSectionItems");
    expect(builder).toContain('settings: items.length > 0 ? { items } : {}');
  });

  it("components and homes consume settings items with default fallback", () => {
    const usp = readFileSync("src/components/storefront/sections/USPGrid.astro", "utf8");
    expect(usp).toContain("parseSectionItems(settings?.items)");
    expect(usp).toContain("[...custom, ...defaults].slice(0, 3)");
    const faq = readFileSync("src/components/storefront/sections/FAQSection.astro", "utf8");
    expect(faq).toContain("parseSectionItems(settings?.items)");
    const home = readFileSync("src/components/storefront/templates/bustle/StoreHome.astro", "utf8");
    expect(home).toContain('universalSectionSettings(shop.content.sections ?? [], "usp")');
  });
});

describe("TM3 signature moments render contract", () => {
  it("ships the behaviors bundle and per-template data hooks", () => {
    const script = readFileSync("src/scripts/storefront/tm3-signatures.ts", "utf8");
    expect(script).toContain("bindInstantSearch");
    expect(script).toContain("bindFlashCountdowns");
    expect(script).toContain("bindQuickAdd");
    expect(script).toContain("bindSpecPeek");
    expect(script).toContain("bindStockBars");
    expect(script).toContain("bindNextSlotChip");
    expect(script).toContain("/api/store/booking/slots");

    const swift = readFileSync("src/components/storefront/templates/swift/StoreHome.astro", "utf8");
    expect(swift).toContain("tm3-signatures.ts");
    const pulse = readFileSync("src/components/storefront/templates/pulse/StoreHome.astro", "utf8");
    expect(pulse).toContain("data-flash-countdown");
    expect(pulse).toContain("pulse-flash-card");
    const aurora = readFileSync("src/components/storefront/templates/aurora/StoreHome.astro", "utf8");
    expect(aurora).toContain("data-quick-add-variants");
    const metro = readFileSync("src/components/storefront/templates/metro/StoreHome.astro", "utf8");
    expect(metro).toContain("data-spec-peek");
    const bustle = readFileSync("src/components/storefront/templates/bustle/StoreHome.astro", "utf8");
    expect(bustle).toContain("data-stock-total");
    for (const tpl of ["serenity", "craft", "clinic"]) {
      const home = readFileSync(`src/components/storefront/templates/${tpl}/StoreHome.astro`, "utf8");
      expect(home, tpl).toContain("data-next-slot-chip");
      expect(home, tpl).toContain("data-next-slot-variant");
      expect(home, tpl).toContain("tm3-signatures.ts");
    }
    const css = readFileSync("src/styles/storefront/sections.css", "utf8");
    expect(css).toContain(".instant-search-results");
    expect(css).toContain(".pulse-flash-card");
    expect(css).toContain(".quick-add-pop");
    expect(css).toContain(".spec-peek-overlay");
    expect(css).toContain(".stock-progress");
    expect(css).toContain(".next-slot-chip");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("sources next-slot data from the first bookable variant only (honest data)", () => {
    const script = readFileSync("src/scripts/storefront/tm3-signatures.ts", "utf8");
    expect(script).toContain("body.slots?.[0]");
    expect(script).toContain("// Network failures leave the chip hidden");
    const home = readFileSync("src/components/storefront/templates/serenity/StoreHome.astro", "utf8");
    expect(home).toContain("firstBookable");
  });
});

describe("TM4 merchandising contracts", () => {
  it("surfaces real soldCount and createdAt from the catalog projection", () => {
    const store = readFileSync("src/lib/storefront/store.ts", "utf8");
    expect(store).toContain("AS soldCount");
    expect(store).toContain("payment_status = 'paid'");
    expect(store).toContain("soldCount: row.soldCount");
    expect(store).toContain("createdAt: row.productCreatedIso");
    expect(store).toContain('export type StorefrontBadge = "best" | "hot" | "new"');
  });

  it("ProductCard derives badges from real signals (no invented numbers)", () => {
    const card = readFileSync("src/components/storefront/ProductCard.astro", "utf8");
    expect(card).toContain("product.soldCount >= 5");
    expect(card).toContain("21 * 86_400_000");
    expect(card).toContain("product-auto-badge");
    expect(card).toContain('badge === "best" ? t("storefront.tm4.badge.best"');
  });

  it("keeps decorative storefront visuals out of hidden interactive containers", () => {
    const card = readFileSync("src/components/storefront/ProductCard.astro", "utf8");
    const pulse = readFileSync("src/components/storefront/templates/pulse/StoreHome.astro", "utf8");
    expect(card).toContain('<div class="product-visual"');
    expect(card).not.toMatch(/<a[^>]*aria-hidden="true"/u);
    expect(pulse).not.toMatch(/<a[^>]*aria-hidden="true"/u);
    expect(pulse).toContain('aria-label={product.title}');
  });

  it("gives quick-add and full add-to-cart controls distinct accessible names", () => {
    const card = readFileSync("src/components/storefront/ProductCard.astro", "utf8");
    expect(card).toContain('t("storefront.product.quick_add")');
    expect(card).toContain('t("storefront.product.add")');
  });

  it("ships recently viewed + cart cross-sell + detail tracking wired to localStorage", () => {
    const script = readFileSync("src/scripts/storefront/tm4-merchandising.ts", "utf8");
    expect(script).toContain("selinow-viewed:v1:");
    expect(script).toContain("readViewed");
    expect(script).toContain("data-detail-track");
    expect(script).toContain("data-cross-sell-grid");
    expect(script).toContain("cartCategories.size === 0");
    // Suggestions come from the embedded catalog, not a new network call.
    expect(script).toContain("#catalog-data");
    const cart = readFileSync("src/pages/cart.astro", "utf8");
    expect(cart).toContain("cross-sell-section");
    expect(cart).toContain("tm4-merchandising.ts");
    const detail = readFileSync("src/pages/products/[slug].astro", "utf8");
    expect(detail).toContain("data-detail-track");
    for (const templateId of ["swift", "pulse", "desk", "aurora", "metro", "bustle", "serenity", "craft", "clinic"]) {
      const home = readFileSync(`src/components/storefront/templates/${templateId}/StoreHome.astro`, "utf8");
      expect(home, templateId).toContain("data-recently-viewed-rail");
      expect(home, templateId).toContain("tm4-merchandising.ts");
    }
  });
});

describe("TV template vitality contracts", () => {
  it("ships section rhythm, hero mesh, card interactions, and responsive fluid in the shared sheet", () => {
    const css = readFileSync("src/styles/storefront/sections.css", "utf8");
    // 1. Section rhythm: alternating tones + varied padding + dividers
    expect(css).toContain("main > section:nth-of-type(even)");
    expect(css).toContain("+ section::before");
    expect(css).toContain("clamp(48px, 7vw, 88px)");
    // 2. Hero vitality: gradient mesh + staggered entrance + fluid type
    expect(css).toContain("hero-mesh-drift");
    expect(css).toContain("hero-text-enter");
    expect(css).toContain("clamp(2.5rem, 7vw, 5.5rem)");
    // 3. Card interactions: hover elevation + image zoom
    expect(css).toContain(".product-card:hover");
    expect(css).toContain("scale(1.06)");
    // 4. Responsive fluid: auto-fill minmax grids
    expect(css).toContain("repeat(auto-fill, minmax(clamp(240px, 28vw, 340px), 1fr))");
    expect(css).toContain("repeat(auto-fill, minmax(clamp(280px, 36vw, 420px), 1fr))");
    // 5. Mobile UX: quick-add bottom sheet + touch spec-peek
    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain(".quick-add-pop");
    expect(css).toContain("(hover: none)");
    // 6. Scroll-based stagger
    expect(css).toContain("section-child-enter");
    expect(css).toContain("--child-i");
    // 7. Reduced motion coverage
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.store-hero::after[\s\S]*?animation: none/u);
  });

  it("every template home loads the reveal boot for scroll-based entrance", () => {
    for (const templateId of ["swift", "pulse", "desk", "aurora", "metro", "bustle", "serenity", "craft", "clinic"]) {
      const home = readFileSync(`src/components/storefront/templates/${templateId}/StoreHome.astro`, "utf8");
      expect(home, templateId).toContain("reveal-boot.ts");
    }
  });
});

describe("TM1 builder render contract", () => {
  it("ships the layout tab, hidden sections field, and panel wiring", () => {
    const store = readFileSync("src/pages/app/store.astro", "utf8");
    expect(store).toContain('data-tab="sections"');
    expect(store).toContain('id="panel-sections"');
    expect(store).toContain('data-field="sections"');
    expect(store).toContain("data-section-stack");
    expect(store).toContain("data-section-restore");
    expect(store).toContain("data-preview-usp");
    expect(store).toContain("data-preview-faq");
    expect(store).toContain("resolveHomeSections");
    const builder = readFileSync("src/scripts/dashboard/store-builder.ts", "utf8");
    expect(builder).toContain("writeSectionsField");
    expect(builder).toContain("syncSectionPreview");
    expect(builder).toContain('data-section-restore');
    const route = readFileSync("src/pages/api/app/shops/[shopPublicId]/settings.ts", "utf8");
    expect(route).toContain('"sections"');
  });

  it("renders the universal tail from the resolved config in every template home", () => {
    for (const templateId of ["swift", "pulse", "desk", "aurora", "metro", "bustle", "serenity", "craft", "clinic"]) {
      const home = readFileSync(`src/components/storefront/templates/${templateId}/StoreHome.astro`, "utf8");
      expect(home, templateId).toContain("resolveUniversalSections(shop.template.id, shop.content.sections");
      expect(home, templateId).toContain("universalTail.map");
    }
  });
});
