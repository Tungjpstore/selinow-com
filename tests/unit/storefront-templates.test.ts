import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { parseStorefrontContent } from "../../src/lib/storefront/theme";
import { resolveStorefrontShop } from "../../src/lib/storefront/store";
import {
  FALLBACK_STOREFRONT_TEMPLATE,
  PREMIUM_STOREFRONT_TEMPLATES_FEATURE,
  resolveStorefrontTemplate,
  storefrontTemplateSelectionIssue,
  STOREFRONT_TEMPLATES,
} from "../../src/lib/storefront/templates";
import { createShop } from "../../src/lib/tenants/store";
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

function seedTenant(database: DatabaseSync, vertical: "digital" | "physical" | "booking" = "digital"): void {
  const now = "2026-08-16T00:00:00.000Z";
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run("user-a", "a@example.test", "Owner A", now, now);
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, vertical, created_at, updated_at
    ) VALUES ('shop-a', 'public-a', 'seller-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?, ?)
  `).run(vertical, now, now);
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
    DEFAULT_CURRENCY: "VND",
    DEFAULT_LOCALE: "vi",
    DEFAULT_TIMEZONE: "Asia/Ho_Chi_Minh",
    IDENTIFIER_HMAC_SECRET: "unit-test-identifier-secret",
    PLATFORM_BASE_DOMAIN: "selinow.com",
    PLATFORM_DB: database as unknown as D1Database,
    PLATFORM_ORIGIN: "https://selinow.com",
    SESSION_SECRET: "unit-test-session-secret",
  } as unknown as AppBindings;
}

function grantPremiumTemplates(database: DatabaseSync): void {
  database.prepare("UPDATE plans SET feature_flags_json = ? WHERE id = 'plan_business_v1'")
    .run(JSON.stringify({ [PREMIUM_STOREFRONT_TEMPLATES_FEATURE]: true }));
}

describe("storefront template registry", () => {
  it("grants premium storefront templates to the authoritative Pro plan", () => {
    const database = createDatabase();
    const plan = database.database.prepare(`
      SELECT json_extract(feature_flags_json, '$.premiumStorefrontTemplates') AS premium,
        version
      FROM plans WHERE id = 'plan_pro_v1' AND code = 'pro'
    `).get();

    expect(plan).toMatchObject({ premium: 1 });
  });

  it("fails migration 0116 when the canonical active Pro plan is absent", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        feature_flags_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        is_active INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO plans (id, code, feature_flags_json, version, is_active, updated_at)
      VALUES ('plan_pro_v1', 'pro', '{}', 1, 0, '2026-08-24T00:00:00.000Z');
    `);

    expect(() => { database.exec(readFileSync("migrations/0116_pro_premium_storefront_entitlement.sql", "utf8")); })
      .toThrow(/migration_assert_0116_pro_entitlement|CHECK constraint failed/u);
  });

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
  it("persists a valid template selection and returns the vertical-scoped gallery", async () => {
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
    // OB-A1: the seeded shop is digital, so the gallery only offers digital
    // templates even though the registry carries nine.
    expect(settings.templates.map((template) => template.id)).toEqual(["swift", "pulse", "desk"]);
    const draftRow = database.database.prepare("SELECT storefront_json AS json FROM shop_settings WHERE shop_id = 'shop-a'").get() as { json: string };
    const draft = JSON.parse(draftRow.json) as { templateId?: string };
    expect(draft.templateId).toBe("pulse");
  });

  it("scopes the gallery to a physical shop's vertical templates", async () => {
    const database = createDatabase();
    seedTenant(database.database, "physical");
    const env = appEnv(database);
    const settings = await getSellerStorefrontSettings({ env, shopPublicId: "public-a", userId: "user-a" });
    // Legacy draft without a templateId still renders the swift fallback, so
    // the in-use template stays visible ahead of the physical options. Shops
    // created with one-request provisioning carry an aurora draft instead.
    expect(settings.templates.map((template) => template.id)).toEqual(["swift", "aurora", "metro", "bustle"]);
    expect(settings.template.id).toBe("swift");
    expect(settings.templates.filter((template) => template.vertical === "physical").map((template) => template.id))
      .toEqual(["aurora", "metro", "bustle"]);
  });

  it("keeps a legacy cross-vertical persisted template visible in its own gallery", async () => {
    const database = createDatabase();
    seedTenant(database.database, "physical");
    // Simulate a physical shop created before vertical-aware creation: the
    // persisted draft still points at a digital template.
    database.database.prepare(`
      UPDATE shop_settings SET storefront_json = ?, version = 2, updated_at = '2026-08-16T00:00:00.000Z'
      WHERE shop_id = 'shop-a'
    `).run(JSON.stringify({ templateId: "pulse" }));
    grantPremiumTemplates(database.database);
    const env = appEnv(database);
    const settings = await getSellerStorefrontSettings({ env, shopPublicId: "public-a", userId: "user-a" });
    expect(settings.template.id).toBe("pulse");
    // The out-of-vertical current pick stays visible so it can be reviewed.
    expect(settings.templates.map((template) => template.id)).toEqual(["pulse", "aurora", "metro", "bustle"]);
  });

  it("rejects selecting a template outside the shop's vertical", async () => {
    const database = createDatabase();
    seedTenant(database.database, "physical");
    const env = appEnv(database);
    await expect(updateSellerStorefrontSettings({
      data: { templateId: "swift" },
      env,
      expectedVersion: 1,
      shopPublicId: "public-a",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["storefront_template_vertical_mismatch"], status: 400 });
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

describe("one-request shop provisioning (OB-B1)", () => {
  function seedCreator(database: DatabaseSync, userId: string): void {
    const now = "2026-08-16T00:00:00.000Z";
    database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .run(userId, `${userId}@example.test`, "Creator", now, now);
  }

  it("lands vertical, template and channels in the creation transaction", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedCreator(database.database, "user-b");
    const env = appEnv(database);
    const result = await createShop({
      channels: { customDomainPreference: "later", telegramEnabled: true, websiteEnabled: true },
      currency: "VND",
      defaultLocale: "vi",
      env,
      idempotencyKey: "shop-create-unit-0001",
      name: "Tiệm Quà",
      planCode: "starter",
      requesterAddress: "203.0.113.10",
      requestId: "request-b1",
      slug: "tiem-qua",
      templateId: "aurora",
      userId: "user-b",
      vertical: "physical",
    });
    expect(result.created).toBe(true);
    expect(result.shop.vertical).toBe("physical");

    // Storefront draft starts on the picked template — no follow-up PATCH.
    const settings = database.database.prepare(`
      SELECT storefront_json AS json FROM shop_settings
      WHERE shop_id = (SELECT id FROM shops WHERE slug = 'tiem-qua')
    `).get() as { json: string };
    expect((JSON.parse(settings.json) as { templateId?: string }).templateId).toBe("aurora");

    // Channel choice is persisted in the same transaction.
    const profile = database.database.prepare(`
      SELECT website_enabled AS website, telegram_enabled AS telegram
      FROM shop_onboarding_profiles
      WHERE shop_id = (SELECT id FROM shops WHERE slug = 'tiem-qua')
    `).get() as { website: number; telegram: number };
    expect(profile.website).toBe(1);
    expect(profile.telegram).toBe(1);

    const steps = database.database.prepare(`
      SELECT step_code AS code, status FROM shop_onboarding_steps
      WHERE shop_id = (SELECT id FROM shops WHERE slug = 'tiem-qua')
        AND step_code IN ('channel_selected', 'telegram_ready')
    `).all() as Array<{ code: string; status: string }>;
    const byCode = new Map(steps.map((step) => [step.code, step.status]));
    expect(byCode.get("channel_selected")).toBe("complete");
    expect(byCode.get("telegram_ready")).toBe("pending");

    const gallery = await getSellerStorefrontSettings({ env, shopPublicId: result.shop.publicId, userId: "user-b" });
    expect(gallery.template.id).toBe("aurora");
    expect(gallery.templates.map((template) => template.id)).toEqual(["aurora", "metro", "bustle"]);
  });

  it("defaults the draft to the vertical's safe template when none is passed", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedCreator(database.database, "user-c");
    const result = await createShop({
      env: appEnv(database),
      idempotencyKey: "shop-create-unit-0002",
      name: "Lịch Hẹn",
      planCode: "starter",
      requesterAddress: "203.0.113.11",
      requestId: "request-b2",
      slug: "lich-hen",
      userId: "user-c",
      vertical: "booking",
    });
    expect(result.created).toBe(true);
    const settings = database.database.prepare(`
      SELECT storefront_json AS json FROM shop_settings
      WHERE shop_id = (SELECT id FROM shops WHERE slug = 'lich-hen')
    `).get() as { json: string };
    expect((JSON.parse(settings.json) as { templateId?: string }).templateId).toBe("serenity");
  });

  it("rejects premium templates without entitlement and cross-vertical picks", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedCreator(database.database, "user-d");
    const env = appEnv(database);
    await expect(createShop({
      env,
      idempotencyKey: "shop-create-unit-0003",
      name: "Shop Metro",
      planCode: "starter",
      requesterAddress: "203.0.113.12",
      requestId: "request-b3",
      slug: "shop-metro",
      templateId: "metro",
      userId: "user-d",
      vertical: "physical",
    })).rejects.toMatchObject({ code: "authorization_denied", issues: ["storefront_template_premium_required"], status: 403 });

    await expect(createShop({
      env,
      idempotencyKey: "shop-create-unit-0004",
      name: "Shop Sai Nganh",
      planCode: "starter",
      requesterAddress: "203.0.113.12",
      requestId: "request-b4",
      slug: "shop-sai-nganh",
      templateId: "swift",
      userId: "user-d",
      vertical: "physical",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["storefront_template_vertical_mismatch"], status: 400 });

    await expect(createShop({
      channels: { customDomainPreference: "later", telegramEnabled: false, websiteEnabled: false },
      env,
      idempotencyKey: "shop-create-unit-0005",
      name: "Shop Vo Kenh",
      planCode: "starter",
      requesterAddress: "203.0.113.12",
      requestId: "request-b5",
      slug: "shop-vo-kenh",
      userId: "user-d",
      vertical: "digital",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["onboarding_channel_required"], status: 400 });
  });
});
