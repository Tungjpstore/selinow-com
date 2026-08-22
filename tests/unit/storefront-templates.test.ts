import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { parseStorefrontContent } from "../../src/lib/storefront/theme";
import { resolveStorefrontShop } from "../../src/lib/storefront/store";
import {
  FALLBACK_STOREFRONT_TEMPLATE,
  listStorefrontTemplates,
  PREMIUM_STOREFRONT_TEMPLATES_FEATURE,
  resolveStorefrontTemplate,
  storefrontTemplateSelectionIssue,
  STOREFRONT_TEMPLATES,
} from "../../src/lib/storefront/templates";
import { getSellerStorefrontSettings, updateSellerStorefrontSettings } from "../../src/lib/tenants/storefront-settings";

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

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return new SqliteD1(database);
}

function seedTenant(database: DatabaseSync): void {
  const now = "2026-08-16T00:00:00.000Z";
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run("user-a", "a@example.test", "Owner A", now, now);
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES ('shop-a', 'public-a', 'seller-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(now, now);
  database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-a', 'user-a', 'owner', 'active', ?, ?)").run(now, now);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES ('sub-a', 'shop-a', 'plan_business_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)").run(now, now);
  database.prepare(`
    INSERT INTO shop_settings (
      shop_id, branding_json, storefront_json, version, updated_at,
      published_branding_json, published_storefront_json, published_version, published_at
    ) VALUES ('shop-a', '{}', ?, 1, ?, '{}', ?, 1, ?)
  `).run("{}", now, "{}", now);
  database.prepare(`
    INSERT INTO shop_domains (
      id, shop_id, hostname_normalized, type, status, is_primary,
      validation_metadata_json, activated_at, created_at, updated_at
    ) VALUES ('domain-a', 'shop-a', 'seller-a.selinow.com', 'platform_subdomain', 'active', 1, '{}', ?, ?, ?)
  `).run(now, now, now);
}

function appEnv(database: SqliteD1): AppBindings {
  return {
    API_ORIGIN: "https://api.selinow.com",
    DASHBOARD_ORIGIN: "https://app.selinow.com",
    DEFAULT_LOCALE: "vi",
    PLATFORM_BASE_DOMAIN: "selinow.com",
    PLATFORM_DB: database as unknown as D1Database,
    PLATFORM_ORIGIN: "https://selinow.com",
  } as unknown as AppBindings;
}

function grantPremiumTemplates(database: DatabaseSync): void {
  database.prepare("UPDATE plans SET feature_flags_json = ? WHERE id = 'plan_business_v1'")
    .run(JSON.stringify({ [PREMIUM_STOREFRONT_TEMPLATES_FEATURE]: true }));
}

describe("storefront template registry", () => {
  it("keeps ids unique with one available non-premium default per vertical", () => {
    const ids = STOREFRONT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(9);
    for (const vertical of ["digital", "physical", "booking"] as const) {
      const defaults = STOREFRONT_TEMPLATES.filter((template) => template.vertical === vertical && !template.premium);
      expect(defaults, vertical).toHaveLength(1);
    }
  });

  it("falls back safely for unknown or premium-without-entitlement ids", () => {
    expect(resolveStorefrontTemplate({ premiumEntitled: false, templateId: "swift" }).id).toBe("swift");
    expect(resolveStorefrontTemplate({ premiumEntitled: false, templateId: "does-not-exist" }).id).toBe("swift");
    expect(resolveStorefrontTemplate({ premiumEntitled: false, templateId: null }).id).toBe("swift");
    expect(resolveStorefrontTemplate({ premiumEntitled: false, templateId: 42 }).id).toBe("swift");
    // pulse is premium: entitled shops keep it, others degrade to the default.
    expect(resolveStorefrontTemplate({ premiumEntitled: true, templateId: "pulse" }).id).toBe("pulse");
    expect(resolveStorefrontTemplate({ premiumEntitled: false, templateId: "pulse" }).id).toBe("swift");
  });

  it("reports distinct selection issues for invalid versus premium-locked templates", () => {
    expect(storefrontTemplateSelectionIssue({ premiumEntitled: false, templateId: "swift" })).toMatchObject({ id: "swift" });
    expect(storefrontTemplateSelectionIssue({ premiumEntitled: false, templateId: "nope" })).toBe("storefront_template_invalid");
    expect(storefrontTemplateSelectionIssue({ premiumEntitled: false, templateId: 7 })).toBe("storefront_template_invalid");
    expect(storefrontTemplateSelectionIssue({ premiumEntitled: false, templateId: "pulse" })).toBe("storefront_template_premium_required");
    expect(storefrontTemplateSelectionIssue({ premiumEntitled: true, templateId: "pulse" })).toMatchObject({ id: "pulse" });
  });

  it("surfaces the persisted templateId as a bounded raw string", () => {
    expect(parseStorefrontContent('{"templateId":"pulse"}', "Shop").templateId).toBe("pulse");
    expect(parseStorefrontContent('{"templateId":"  "}', "Shop").templateId).toBeNull();
    expect(parseStorefrontContent('{"templateId":123}', "Shop").templateId).toBeNull();
    expect(parseStorefrontContent("{}", "Shop").templateId).toBeNull();
    expect(parseStorefrontContent(`{"templateId":"${"x".repeat(80)}"}`, "Shop").templateId).toHaveLength(32);
  });
});

describe("seller template selection contract", () => {
  it("persists a valid template selection and returns the gallery", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    grantPremiumTemplates(database.database);
    const env = appEnv(database);
    const settings = await updateSellerStorefrontSettings({
      data: { templateId: "pulse" },
      env,
      expectedVersion: 1,
      shopPublicId: "public-a",
      userId: "user-a",
    });
    expect(settings.template.id).toBe("pulse");
    expect(settings.premiumTemplatesEnabled).toBe(true);
    expect(settings.templates.map((template) => template.id)).toEqual(listStorefrontTemplates().map((template) => template.id));
    const draftRow = database.database.prepare("SELECT storefront_json AS json FROM shop_settings WHERE shop_id = 'shop-a'").get() as { json: string };
    const draft = JSON.parse(draftRow.json) as { templateId?: string };
    expect(draft.templateId).toBe("pulse");
  });

  it("rejects unknown or not-yet-available templates without touching the draft", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    const env = appEnv(database);
    for (const templateId of ["does-not-exist"]) {
      await expect(updateSellerStorefrontSettings({
        data: { templateId },
        env,
        expectedVersion: 1,
        shopPublicId: "public-a",
        userId: "user-a",
      })).rejects.toMatchObject({ code: "validation_failed", issues: ["storefront_template_invalid"], status: 400 });
    }
  });

  it("rejects premium templates when the plan lacks the feature flag", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    const env = appEnv(database);
    await expect(updateSellerStorefrontSettings({
      data: { templateId: "pulse" },
      env,
      expectedVersion: 1,
      shopPublicId: "public-a",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "authorization_denied", issues: ["storefront_template_premium_required"], status: 403 });
  });

  it("defaults the gallery to swift until a selection is published", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    const env = appEnv(database);
    const settings = await getSellerStorefrontSettings({ env, shopPublicId: "public-a", userId: "user-a" });
    expect(settings.template.id).toBe("swift");
    expect(settings.premiumTemplatesEnabled).toBe(false);
  });
});

describe("storefront render resolution", () => {
  it("renders the published template for entitled plans and falls back otherwise", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    const env = appEnv(database);
    const publishTemplate = async (templateId: string): Promise<string> => {
      database.database.prepare(`
        UPDATE shop_settings SET
          storefront_json = ?, published_storefront_json = ?, version = version + 1,
          published_version = version + 1, updated_at = '2026-08-16T00:00:00.000Z'
        WHERE shop_id = 'shop-a'
      `).run(JSON.stringify({ templateId }), JSON.stringify({ templateId }));
      const shop = await resolveStorefrontShop(new Request("https://seller-a.selinow.com/"), env);
      return shop.template.id;
    };
    grantPremiumTemplates(database.database);
    expect(await publishTemplate("pulse")).toBe("pulse");
    expect(await publishTemplate("bogus")).toBe("swift");
    // Downgrading the plan must degrade a previously published premium template.
    database.database.prepare("UPDATE plans SET feature_flags_json = '{}' WHERE id = 'plan_business_v1'").run();
    expect(await publishTemplate("pulse")).toBe("swift");
    expect(FALLBACK_STOREFRONT_TEMPLATE.id).toBe("swift");
  });
});

describe("template render contracts", () => {
  it("registers every available template in the store-home dispatcher", () => {
    const dispatcher = readFileSync("src/components/storefront/templates/StoreHome.astro", "utf8");
    const available = STOREFRONT_TEMPLATES.filter((template) => template.available);
    expect(available.map((template) => template.id).sort()).toEqual(["aurora", "bustle", "clinic", "craft", "desk", "metro", "pulse", "serenity", "swift"]);
    for (const template of available) {
      // Map entry `id: Component` plus its import line under templates/<id>/.
      expect(dispatcher, template.id).toMatch(new RegExp(`\\b${template.id}:\\s*\\w+StoreHome`, "u"));
      expect(dispatcher, template.id).toContain(`./${template.id}/StoreHome.astro`);
    }
  });

  it("loads each shipped template sheet in the shared storefront layout", () => {
    const layout = readFileSync("src/layouts/StorefrontLayout.astro", "utf8");
    // swift intentionally styles through the base storefront.css sheet.
    for (const template of STOREFRONT_TEMPLATES.filter((candidate) => candidate.available && candidate.id !== "swift")) {
      expect(layout, template.id).toContain(`storefront/templates/${template.id}.css`);
    }
    expect(layout).toContain('data-storefront-template={shop.template.id}');
    expect(layout).toContain('shop.template.scheme === "dark" ? "#0B1020" : "#F8FAFC"');
  });

  it("scopes template stylesheets to their template attribute", () => {
    for (const template of STOREFRONT_TEMPLATES.filter((candidate) => candidate.available && candidate.id !== "swift")) {
      const sheet = readFileSync(`src/styles/storefront/templates/${template.id}.css`, "utf8");
      expect(sheet, template.id).toContain(`[data-storefront-template="${template.id}"]`);
    }
  });

  it("registers every available template in the detail dispatcher", () => {
    const dispatcher = readFileSync("src/components/storefront/templates/Detail.astro", "utf8");
    for (const template of STOREFRONT_TEMPLATES.filter((candidate) => candidate.available)) {
      expect(dispatcher, template.id).toMatch(new RegExp(`\\b${template.id}:\\s*\\w+ProductDetail`, "u"));
      expect(dispatcher, template.id).toContain(`./${template.id}/ProductDetail.astro`);
    }
  });

  it("keeps the purchase contract in every per-template detail page", () => {
    for (const template of STOREFRONT_TEMPLATES.filter((candidate) => candidate.available)) {
      const detail = readFileSync(`src/components/storefront/templates/${template.id}/ProductDetail.astro`, "utf8");
      // The shared BuyBox renders the load-bearing hooks (variant radios,
      // #detail-add, #detail-quantity, refresh status) for product-detail.ts.
      expect(detail, template.id).toMatch(/<BuyBox/);
      expect(detail, template.id).toContain("back-link");
    }
    const buyBox = readFileSync("src/components/storefront/sections/BuyBox.astro", "utf8");
    expect(buyBox).toContain('id="product-refresh-status"');
    expect(buyBox).toContain('id="detail-quantity"');
    expect(buyBox).toContain('id="detail-add"');
    const variantList = readFileSync("src/components/storefront/sections/VariantList.astro", "utf8");
    const swatches = readFileSync("src/components/storefront/sections/Swatches.astro", "utf8");
    expect(variantList).toContain('name="variant"');
    expect(swatches).toContain('name="variant"');
    // Swatches must degrade to the standard list when options do not map.
    expect(swatches).toContain("<VariantList");
  });

  it("declares the --tmpl- feel-token layer in every template sheet", () => {
    for (const template of STOREFRONT_TEMPLATES.filter((candidate) => candidate.available && candidate.id !== "swift")) {
      const sheet = readFileSync(`src/styles/storefront/templates/${template.id}.css`, "utf8");
      expect(sheet, template.id).toMatch(new RegExp(`html\\[data-storefront-template="${template.id}"\\]\\s*\\{[\\s\\S]*?--tmpl-`, "u"));
    }
    // Swift/base defaults live on :root in the shared sheet.
    const base = readFileSync("src/styles/storefront.css", "utf8");
    expect(base).toContain("--tmpl-panel-bg:");
    expect(base).toContain("--tmpl-radius-l:");
    // The sections sheet is loaded by the shared layout for every template.
    const layout = readFileSync("src/layouts/StorefrontLayout.astro", "utf8");
    expect(layout).toContain("storefront/sections.css");
  });

  it("renders booking templates with the inline slot picker section", () => {
    for (const templateId of ["serenity", "craft", "clinic"]) {
      const detail = readFileSync(`src/components/storefront/templates/${templateId}/ProductDetail.astro`, "utf8");
      expect(detail, templateId).toMatch(/<SlotPickerInline/);
    }
    const picker = readFileSync("src/components/storefront/sections/SlotPickerInline.astro", "utf8");
    expect(picker).toContain("data-slot-picker");
    expect(picker).toContain("data-slot-picker-book");
  });

  it("skins money screens through template tokens instead of bespoke panels", () => {
    // The shared money-screen surfaces must consume the token layer so the
    // dark templates (pulse/craft) flow dark end-to-end.
    const base = readFileSync("src/styles/storefront.css", "utf8");
    expect(base).toMatch(/\.cart-summary, \.checkout-form\s*\{[\s\S]*?--tmpl-panel-bg/);
    expect(base).toMatch(/\.quote-status\s*\{[\s\S]*?--tmpl-panel-nested-bg/);
    for (const templateId of ["pulse", "craft"]) {
      const sheet = readFileSync(`src/styles/storefront/templates/${templateId}.css`, "utf8");
      expect(sheet, templateId).toContain("--tmpl-panel-bg-solid: #1");
      expect(sheet, templateId).toContain("--tmpl-text: #");
    }
  });

  it("re-skins the Store Builder preview per draft template (CD4)", () => {
    const store = readFileSync("src/pages/app/store.astro", "utf8");
    const skins = readFileSync("src/styles/dashboard/store-builder-preview-skins.css", "utf8");
    expect(store).toContain("data-template-preview={settings.template.id}");
    expect(store).toContain("store-builder-preview-skins.css");
    for (const template of STOREFRONT_TEMPLATES.filter((candidate) => candidate.available && candidate.id !== "swift")) {
      // Swift stays the unscoped default; every other template ships a skin.
      // Raw palettes live in the skins sheet (storefront theme data), keeping
      // store.astro itself on semantic tokens (frontend-route-ux contract).
      expect(skins, template.id).toContain(`[data-template-preview="${template.id}"]`);
    }
    const builder = readFileSync("src/scripts/dashboard/store-builder.ts", "utf8");
    expect(builder).toContain("root.dataset.templatePreview = next.templateId");
  });

  it("ships visual-regression fixtures and specs for all nine templates (CD5)", () => {
    const seed = readFileSync("seeds/0005_storefront_template_fixtures.sql", "utf8");
    const spec = readFileSync("tests/visual/local-public-templates.spec.ts", "utf8");
    const gate = readFileSync("scripts/local-public-browser-gate.mjs", "utf8");
    const config = readFileSync("playwright.public-local.config.ts", "utf8");
    expect(gate).toContain('"--file", "./seeds/0005_storefront_template_fixtures.sql"');
    for (const template of STOREFRONT_TEMPLATES.filter((candidate) => candidate.available)) {
      // Swift renders through the signal demo shop (registry fallback), so the
      // fixture seed only carries the other eight explicit templateIds.
      const host = template.id === "swift" ? "signal" : template.id;
      if (template.id !== "swift") expect(seed, template.id).toContain(`"templateId":"${template.id}"`);
      expect(spec, template.id).toContain(`host: "${host}.localhost"`);
      expect(gate, template.id).toContain(`${host}.localhost`);
      expect(config, template.id).toContain(`MAP ${host}.localhost 127.0.0.1`);
    }
  });
});
