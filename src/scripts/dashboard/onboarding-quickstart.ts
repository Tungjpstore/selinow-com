type WizardStep = "connect" | "inventory" | "launch" | "product" | "store";
type Vertical = "digital" | "physical" | "booking";

const STEP_ORDER: WizardStep[] = ["store", "product", "inventory", "connect", "launch"];

type TemplateCardData = {
  description: string;
  id: string;
  name: string;
  premium: boolean;
  scheme: string;
};

type PresetCardData = {
  currency: string;
  description: string;
  fulfillmentType: string;
  icon: string;
  id: string;
  priceMinor: number;
  sku: string;
  slug: string;
  title: string;
  vertical: Vertical;
};

type ProductStepConfig = {
  customDescDefault: string;
  customDescPlaceholder: string;
  customTitleDefault: string;
  customTitlePlaceholder: string;
  fulfillmentLabel: string;
  fulfillmentOptions: Array<{ label: string; value: string }>;
  heroDesc: string;
  heroTitle: string;
  presetsSublabel: string;
  priceDefault: number;
  submitLabel: string;
};

type InventoryStepConfig = {
  heroDesc: string;
  heroTitle: string;
  label: string;
  metricValid: string;
  orSeparator: string;
  placeholder: string;
  sampleBtn: string;
  skipLabel: string;
  submitLabel: string;
  unitBadge: string;
  vaultNote: string;
};

type ResumeState = {
  catalog: {
    firstVariantId: string | null;
    firstVariantTitle: string | null;
    hasManualProduct: boolean;
    hasProducts: boolean;
    hasStock: boolean;
    totalAvailableStock: number;
  };
  channels: {
    telegramEnabled: boolean;
    websiteEnabled: boolean;
  };
  integrations: {
    payosReady: boolean;
    telegramBotUsername: string | null;
    telegramReady: boolean;
  };
  shop: {
    name: string;
    slug: string;
    templateId: string;
    vertical: Vertical;
  };
  storefrontVersion: number;
  wizardStep: WizardStep;
};

type ShopResponse = {
  shop?: {
    name?: string;
    publicId?: string;
    slug?: string;
  };
};

type SeedResponse = {
  importedKeysCount?: number;
  product?: {
    fulfillmentType?: string;
  };
  variant?: {
    id?: string;
  };
};

type ProductCreateResponse = {
  variant?: {
    id?: string;
  };
};

type StorefrontSettingsResponse = {
  settings?: {
    publicationState?: string;
    publishedAt?: string | null;
    publishedVersion?: number;
    version?: number;
  };
};

type InventoryPreviewResponse = {
  previewToken?: string;
};

type InventoryImportResponse = {
  acceptedCount?: number;
};

type TelegramResponse = {
  integration?: {
    bot?: {
      username?: string;
    };
  };
};

// Lightweight canvas confetti burst
function triggerConfetti(): void {
  const canvas = document.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "9999";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles: Array<{
    color: string;
    r: number;
    tilt: number;
    tiltAngle: number;
    tiltAngleIncremental: number;
    vx: number;
    vy: number;
    x: number;
    y: number;
  }> = [];

  const colors = ["#4f46e5", "#06b6d4", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6"];

  for (let i = 0; i < 120; i++) {
    particles.push({
      color: colors[Math.floor(Math.random() * colors.length)] ?? "#4f46e5",
      r: Math.random() * 6 + 4,
      tilt: Math.floor(Math.random() * 10) - 10,
      tiltAngle: 0,
      tiltAngleIncremental: Math.random() * 0.07 + 0.05,
      vx: (Math.random() - 0.5) * 8,
      vy: Math.random() * -12 - 4,
      x: canvas.width / 2,
      y: canvas.height * 0.45,
    });
  }

  let animationFrame: number;
  let elapsed = 0;

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    elapsed++;

    for (const p of particles) {
      p.tiltAngle += p.tiltAngleIncremental;
      p.y += (Math.cos(p.tiltAngle) + 3 + p.r / 2) / 2;
      p.x += Math.sin(p.tiltAngle) * 2 + p.vx;
      p.vy += 0.2;
      p.y += p.vy * 0.3;
      p.tilt = Math.sin(p.tiltAngle) * 12;

      ctx.beginPath();
      ctx.lineWidth = p.r / 2;
      ctx.strokeStyle = p.color;
      ctx.moveTo(p.x + p.tilt + p.r / 4, p.y);
      ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 4);
      ctx.stroke();
    }

    if (elapsed < 160) {
      animationFrame = requestAnimationFrame(render);
    } else {
      cancelAnimationFrame(animationFrame);
      canvas.remove();
    }
  }

  render();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
}

function readCookie(name: string): string | null {
  const match = new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}=([^;]*)`).exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const inMemoryIntentKeys = new Map<string, { key: string; payload: string }>();

function fallbackIntentDigest(payload: string): string {
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function stableIntentKey(namespace: string, payload: string): Promise<string> {
  const storageKey = `selinow:onboarding:intent:${namespace}`;
  const inMemory = inMemoryIntentKeys.get(storageKey);
  if (inMemory?.payload === payload) return inMemory.key;
  let payloadDigest: string;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    payloadDigest = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    payloadDigest = fallbackIntentDigest(payload);
  }
  try {
    const existing = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { key?: unknown; payloadDigest?: unknown } | null;
    if (existing?.payloadDigest === payloadDigest
      && typeof existing.key === "string"
      && /^[A-Za-z0-9._:-]{16,128}$/u.test(existing.key)) {
      inMemoryIntentKeys.set(storageKey, { key: existing.key, payload });
      return existing.key;
    }
  } catch {
    // The in-memory ledger below preserves response-loss retries when storage
    // is unavailable in hardened or private browsing contexts.
  }
  // Keep every client key within the server's 128-character contract even
  // for tenant + variant namespaces used by inventory imports.
  const randomSuffix = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  const key = `${namespace.slice(0, 40)}-${payloadDigest.slice(0, 24)}-${randomSuffix}`;
  inMemoryIntentKeys.set(storageKey, { key, payload });
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ key, payloadDigest }));
  } catch {
    // The in-memory ledger remains authoritative for this page lifetime.
  }
  return key;
}

async function stableDigestSuffix(payload: string, length = 8): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("").slice(0, length);
}

function clearStableIntent(namespace: string): void {
  inMemoryIntentKeys.delete(`selinow:onboarding:intent:${namespace}`);
  try {
    sessionStorage.removeItem(`selinow:onboarding:intent:${namespace}`);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

function publishedProjection(data: Record<string, unknown>): boolean {
  const candidate = data.settings;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
  const settings = candidate as Record<string, unknown>;
  return settings.publicationState === "published"
    && typeof settings.version === "number"
    && Number.isSafeInteger(settings.version)
    && typeof settings.publishedVersion === "number"
    && settings.publishedVersion === settings.version
    && typeof settings.publishedAt === "string"
    && settings.publishedAt.length > 0;
}

function parseJsonAttribute<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function initQuickstart(): void {
  const _root = document.querySelector<HTMLElement>("[data-quickstart-root]");
  if (!_root) return;
  const root = _root;

  const csrfCookieName = root.dataset.csrfCookieName || "selinow_session_csrf";
  const platformBaseDomain = root.dataset.platformBaseDomain || "selinow.com";
  const defaultCurrency = root.dataset.defaultCurrency || "VND";
  const toastEl = root.querySelector<HTMLElement>("[data-onboarding-toast]");
  const premiumTemplatesEntitled = root.dataset.premiumTemplatesEntitled === "true";
  const requestedPlanCode = root.dataset.requestedPlanCode === "pro" ? "pro" : "starter";
  const creationAllowed = root.dataset.creationAllowed !== "false";

  let activeShopPublicId = root.dataset.activeShopPublicId || "";
  let activeShopSlug = "";
  let activeShopName = "";
  let createdVariantId = "";
  let selectedPresetId = "";
  let currentProductMode: "custom" | "preset" = "preset";
  let importedKeysCount = 0;
  let productIsManual = false;
  let productTitle = "";
  let payosVerified = false;
  let telegramConnected = false;
  let telegramBotUser = "";
  let currentStep: WizardStep = "store";
  let currentVertical: Vertical = "digital";
  let currentUnitBadge = "key trong kho";

  // OB-B4: server-computed resume state for the selected shop.
  const resume = parseJsonAttribute<ResumeState | null>(root.dataset.resumeState, null);
  let storefrontVersion = resume?.storefrontVersion ?? 1;

  function showToast(message: string, tone: "error" | "success" = "success"): void {
    if (!toastEl) return;
    toastEl.dataset.tone = tone;
    toastEl.textContent = message;
    toastEl.hidden = false;
    setTimeout(() => {
      toastEl.hidden = true;
    }, 4000);
  }

  // --- Step navigation with directional transitions ---
  function updateProgress(): void {
    const fill = root.querySelector<HTMLElement>("[data-progress-fill]");
    const track = root.querySelector<HTMLElement>(".progress-track");
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    const percent = Math.round((currentIndex / (STEP_ORDER.length - 1)) * 100);
    if (fill) fill.style.width = `${String(percent)}%`;
    if (track) {
      track.setAttribute("aria-valuenow", String(percent));
    }
    root.querySelectorAll<HTMLElement>("[data-progress-label]").forEach((label) => {
      const labelStep = label.dataset.progressLabel as WizardStep;
      const labelIndex = STEP_ORDER.indexOf(labelStep);
      label.classList.remove("active", "done");
      if (labelIndex === currentIndex) label.classList.add("active");
      else if (labelIndex < currentIndex) label.classList.add("done");
    });
  }

  function setStep(step: WizardStep): void {
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    const nextIndex = STEP_ORDER.indexOf(step);
    const forward = nextIndex >= currentIndex;
    const currentPane = root.querySelector<HTMLElement>(`[data-step-pane="${currentStep}"]`);
    const nextPane = root.querySelector<HTMLElement>(`[data-step-pane="${step}"]`);
    if (!nextPane) return;

    // Reset all step panes display
    for (const pane of root.querySelectorAll<HTMLElement>("[data-step-pane]")) {
      if (pane !== nextPane && pane !== currentPane) {
        pane.classList.remove("is-active", "is-exiting-left", "is-exiting-right");
        pane.style.display = "none";
      }
    }

    if (currentPane && currentPane !== nextPane) {
      const exitClass = forward ? "is-exiting-left" : "is-exiting-right";
      currentPane.classList.remove("is-active", "is-exiting-left", "is-exiting-right");
      currentPane.classList.add(exitClass);
      setTimeout(() => {
        currentPane.classList.remove(exitClass);
        currentPane.style.display = "none";
      }, 260);
    }

    nextPane.hidden = false;
    nextPane.removeAttribute("hidden");
    nextPane.style.display = "flex";
    nextPane.classList.remove("is-exiting-left", "is-exiting-right");
    nextPane.classList.add("is-active");
    currentStep = step;
    updateProgress();
    window.scrollTo({ behavior: "smooth", top: 0 });

    if (step === "launch") {
      refreshLaunchState();
    }
  }

  async function apiRequest(
    url: string,
    options: RequestInit = {},
  ): Promise<{ data: Record<string, unknown>; ok: boolean; status: number }> {
    const csrfToken = readCookie(csrfCookieName) ?? "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      ...(options.headers as Record<string, string>),
    };

    const res = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers,
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { data, ok: res.ok, status: res.status };
  }

  // --- Preview drawer ---
  const drawerPanel = root.querySelector<HTMLElement>("[data-preview-drawer-panel]");
  const drawerBackdrop = root.querySelector<HTMLElement>("[data-preview-drawer-backdrop]");
  const drawerTrigger = root.querySelector<HTMLButtonElement>("[data-preview-drawer-trigger]");

  function openDrawer(): void {
    if (!drawerPanel || !drawerBackdrop || !drawerTrigger) return;
    drawerPanel.hidden = false;
    drawerBackdrop.hidden = false;
    drawerPanel.style.display = "flex";
    drawerBackdrop.style.display = "block";
    drawerTrigger.setAttribute("aria-expanded", "true");
  }

  function closeDrawer(): void {
    if (!drawerPanel || !drawerBackdrop || !drawerTrigger) return;
    drawerPanel.hidden = true;
    drawerBackdrop.hidden = true;
    drawerPanel.style.display = "none";
    drawerBackdrop.style.display = "none";
    drawerTrigger.setAttribute("aria-expanded", "false");
  }

  // Ensure closed on init
  closeDrawer();

  drawerTrigger?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (drawerPanel && (drawerPanel.hidden || drawerPanel.style.display === "none")) openDrawer();
    else closeDrawer();
  });
  drawerBackdrop?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeDrawer();
  });
  for (const closeBtn of root.querySelectorAll<HTMLButtonElement>("[data-preview-drawer-close]")) {
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDrawer();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawerPanel && !drawerPanel.hidden) closeDrawer();
  });

  const previewTabs = root.querySelectorAll<HTMLButtonElement>("[data-preview-mode]");
  const webCanvas = root.querySelector<HTMLElement>("[data-canvas='web']");
  const tgCanvas = root.querySelector<HTMLElement>("[data-canvas='telegram']");

  previewTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      previewTabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      const mode = tab.dataset.previewMode;
      if (webCanvas && tgCanvas) {
        webCanvas.hidden = mode !== "web";
        tgCanvas.hidden = mode !== "telegram";
      }
    });
  });

  // --- Live preview elements ---
  const previewSlugEls = root.querySelectorAll<HTMLElement>("[data-preview-slug]");
  const previewShopNameEls = root.querySelectorAll<HTMLElement>("[data-preview-shop-name]");
  const previewProductTitleEls = root.querySelectorAll<HTMLElement>("[data-preview-product-title]");
  const previewProductTitleShortEls = root.querySelectorAll<HTMLElement>("[data-preview-product-title-short]");
  const previewProductPriceEls = root.querySelectorAll<HTMLElement>("[data-preview-product-price]");
  const previewProductDescEls = root.querySelectorAll<HTMLElement>("[data-preview-product-desc]");
  const previewProductIconEls = root.querySelectorAll<HTMLElement>("[data-preview-product-icon]");
  const previewFulfillmentEls = root.querySelectorAll<HTMLElement>("[data-preview-fulfillment]");

  // --- Step 1: Store & Channels ---
  const storeForm = root.querySelector<HTMLFormElement>("[data-store-form]");
  const storeNameControl = storeForm?.elements.namedItem("name");
  const storeSlugControl = storeForm?.elements.namedItem("slug");
  const nameInput = storeNameControl instanceof HTMLInputElement
    ? storeNameControl
    : root.querySelector<HTMLInputElement>("[data-input-shop-name]");
  const slugInput = storeSlugControl instanceof HTMLInputElement
    ? storeSlugControl
    : root.querySelector<HTMLInputElement>("[data-input-shop-slug]");
  const channelRadios = root.querySelectorAll<HTMLInputElement>("[data-channel-radio]");
  const channelCards = root.querySelectorAll<HTMLElement>("[data-channel-opt]");

  nameInput?.addEventListener("input", () => {
    nameInput.setCustomValidity("");
    nameInput.removeAttribute("aria-invalid");
    const val = nameInput.value.trim();
    const generatedSlug = slugify(val || "cua-hang");
    if (slugInput && (!slugInput.dataset.manual || !slugInput.value)) {
      slugInput.value = generatedSlug;
    }
    previewShopNameEls.forEach((el) => {
      el.textContent = val || "Cửa Hàng Của Bạn";
    });
    previewSlugEls.forEach((el) => {
      el.textContent = slugInput?.value || generatedSlug;
    });
  });

  slugInput?.addEventListener("input", () => {
    slugInput.setCustomValidity("");
    slugInput.removeAttribute("aria-invalid");
    slugInput.dataset.manual = "true";
    const cleaned = slugify(slugInput.value);
    previewSlugEls.forEach((el) => {
      el.textContent = cleaned || "cua-hang";
    });
  });

  channelRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      channelCards.forEach((card) => {
        card.classList.toggle("active", card.contains(radio));
        card.classList.toggle("is-selected", card.contains(radio));
      });
      const tgSection = root.querySelector<HTMLElement>("[data-telegram-connect-section]");
      if (tgSection) {
        tgSection.hidden = radio.value === "website";
      }
    });
  });

  // --- Step 1: Vertical, template & preset data-driven rendering (OB-A1/A2) ---
  const templatesGrid = root.querySelector<HTMLElement>("[data-templates-grid]");
  const templatesMap = parseJsonAttribute<Partial<Record<Vertical, TemplateCardData[]>>>(templatesGrid?.dataset.templatesMap, {});

  function selectedTemplateValue(): string | null {
    return root.querySelector<HTMLInputElement>("input[data-template-radio]:checked")?.value ?? null;
  }

  function applyTemplatePreview(templateId: string): void {
    const previewDrawer = root.querySelector<HTMLElement>("[data-preview-surface]");
    if (previewDrawer) {
      previewDrawer.dataset.previewTemplate = templateId;
    }
  }

  function buildTemplateCard(tpl: TemplateCardData, selected: boolean): HTMLLabelElement {
    const locked = tpl.premium && !premiumTemplatesEntitled;
    const card = document.createElement("label");
    card.className = `template-preset-card${selected ? " is-selected" : ""}${locked ? " is-locked" : ""}`;
    card.dataset.templateId = tpl.id;
    card.dataset.templateLocked = locked ? "true" : "false";
    if (locked) card.setAttribute("aria-disabled", "true");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "storefrontTemplate";
    radio.value = tpl.id;
    radio.checked = selected;
    radio.dataset.templateRadio = "true";
    if (locked) radio.disabled = true;
    card.appendChild(radio);

    const swatch = document.createElement("div");
    swatch.className = "tpl-swatch";
    swatch.dataset.scheme = tpl.scheme;
    for (const [className, bars] of [["tpl-swatch-bar", 1], ["tpl-swatch-hero", 2], ["tpl-swatch-grid", 4]] as const) {
      const row = document.createElement("div");
      row.className = className;
      for (let i = 0; i < bars; i += 1) row.appendChild(document.createElement("i"));
      swatch.appendChild(row);
    }
    card.appendChild(swatch);

    const meta = document.createElement("div");
    meta.className = "tpl-meta";
    const nameRow = document.createElement("div");
    nameRow.className = "tpl-name-row";
    const strong = document.createElement("strong");
    strong.textContent = tpl.name;
    const schemeBadge = document.createElement("span");
    schemeBadge.className = "tpl-scheme-badge";
    schemeBadge.dataset.scheme = tpl.scheme;
    schemeBadge.textContent = tpl.scheme === "dark" ? "Giao diện Tối" : "Giao diện Sáng";
    nameRow.appendChild(strong);
    nameRow.appendChild(schemeBadge);
    const desc = document.createElement("p");
    desc.className = "tpl-desc";
    desc.textContent = tpl.description;
    meta.appendChild(nameRow);
    meta.appendChild(desc);
    card.appendChild(meta);

    if (tpl.premium) {
      const proBadge = document.createElement("span");
      proBadge.className = "tpl-pro-badge";
      proBadge.textContent = "PRO";
      card.appendChild(proBadge);
    }

    const check = document.createElement("span");
    check.className = "card-check";
    check.textContent = "✓";
    card.appendChild(check);
    return card;
  }

  function renderTemplateCards(vertical: Vertical, preferredId: string | null): void {
    if (!templatesGrid) return;
    const templates = templatesMap[vertical] ?? [];
    const preferred = preferredId !== null && templates.some((tpl) => tpl.id === preferredId && !(tpl.premium && !premiumTemplatesEntitled))
      ? preferredId
      : (templates.find((tpl) => !tpl.premium) ?? templates[0])?.id ?? null;
    templatesGrid.replaceChildren(...templates.map((tpl) => buildTemplateCard(tpl, tpl.id === preferred)));
    if (preferred !== null) applyTemplatePreview(preferred);
  }

  // Delegated template card handling (grid content is re-rendered per vertical)
  templatesGrid?.addEventListener("change", (event) => {
    const radio = event.target as HTMLInputElement | null;
    if (!radio?.matches("input[data-template-radio]")) return;
    templatesGrid.querySelectorAll<HTMLElement>("[data-template-id]").forEach((card) => {
      card.classList.toggle("is-selected", card.contains(radio));
    });
    applyTemplatePreview(radio.value);
  });

  templatesGrid?.addEventListener("click", (event) => {
    const lockedCard = (event.target as HTMLElement | null)?.closest<HTMLElement>(".template-preset-card.is-locked");
    if (lockedCard) {
      showToast("Giao diện PRO cần gói Pro — hãy chọn giao diện chuẩn hoặc nâng cấp sau trong Thanh toán.", "error");
    }
  });

  // Keep the server-rendered state fail-closed if stale markup is ever cached.
  if (!premiumTemplatesEntitled) {
    const initialTemplates = templatesMap[currentVertical] ?? [];
    for (const tpl of initialTemplates) {
      if (!tpl.premium) continue;
      const card = templatesGrid?.querySelector<HTMLElement>(`[data-template-id="${tpl.id}"]`);
      card?.classList.add("is-locked");
      card?.setAttribute("aria-disabled", "true");
      if (card !== undefined && card !== null) card.dataset.templateLocked = "true";
      const radio = card?.querySelector<HTMLInputElement>("input[data-template-radio]");
      if (radio !== undefined && radio !== null) {
        radio.disabled = true;
        radio.checked = false;
      }
    }
  }

  // --- Step 2: per-vertical product config (OB-A2/A3) ---
  const productPane = root.querySelector<HTMLElement>('[data-step-pane="product"]');
  const productConfig = parseJsonAttribute<Partial<Record<Vertical, ProductStepConfig>>>(productPane?.dataset.productConfig, {});
  const presetsMap = parseJsonAttribute<Partial<Record<Vertical, PresetCardData[]>>>(productPane?.dataset.presetsMap, {});
  const presetsGrid = root.querySelector<HTMLElement>("[data-presets-grid]");
  const modeTabs = root.querySelectorAll<HTMLButtonElement>("[data-product-mode]");
  const customProductForm = root.querySelector<HTMLFormElement>("[data-product-form]");

  const customTitleInput = root.querySelector<HTMLInputElement>("[data-input-product-title]");
  const customPriceInput = root.querySelector<HTMLInputElement>("[data-input-product-price]");
  const customFulfillmentSelect = root.querySelector("[data-input-product-fulfillment]") as HTMLSelectElement | null;
  const customDescTextarea = root.querySelector<HTMLTextAreaElement>("[data-input-product-desc]");

  // Console Icon renders SVG; preset cards built client-side use matching glyphs.
  const PRESET_ICON_GLYPHS: Record<string, string> = {
    book: "📘",
    box: "📦",
    calendar: "📅",
    gamepad: "🎮",
    music: "🎵",
    palette: "🎨",
    window: "🪟",
    zap: "⚡",
  };

  function buildPresetCard(preset: PresetCardData, selected: boolean): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `preset-card${selected ? " selected" : ""}`;
    card.dataset.presetCard = preset.id;
    card.dataset.presetTitle = preset.title;
    card.dataset.presetPrice = String(preset.priceMinor);
    card.dataset.presetCurrency = preset.currency;
    card.dataset.presetIcon = preset.icon;
    card.dataset.presetFulfillment = preset.fulfillmentType;
    card.dataset.presetDesc = preset.description;

    const icon = document.createElement("span");
    icon.className = "preset-icon";
    icon.textContent = PRESET_ICON_GLYPHS[preset.icon] ?? "⚡";
    card.appendChild(icon);

    const details = document.createElement("div");
    details.className = "preset-details";
    const title = document.createElement("strong");
    title.className = "preset-title";
    title.textContent = preset.title;
    const price = document.createElement("span");
    price.className = "preset-price";
    price.textContent = `${preset.priceMinor.toLocaleString("vi-VN")} ${preset.currency}`;
    const typeBadge = document.createElement("span");
    typeBadge.className = "preset-type-badge";
    typeBadge.textContent = preset.fulfillmentType === "license_key"
      ? "⚡ Giao key tự động"
      : preset.vertical === "booking" ? "📅 Dịch vụ đặt lịch" : "🚚 Giao hàng thủ công";
    details.appendChild(title);
    details.appendChild(price);
    details.appendChild(typeBadge);
    card.appendChild(details);

    const check = document.createElement("span");
    check.className = "preset-badge-check";
    check.textContent = "✓";
    card.appendChild(check);
    return card;
  }

  function renderPresetCards(vertical: Vertical): void {
    if (!presetsGrid) return;
    const presets = presetsMap[vertical] ?? [];
    presetsGrid.replaceChildren(...presets.map((preset, index) => buildPresetCard(preset, index === 0)));
    const first = presets[0];
    selectedPresetId = first?.id ?? "";
    if (first) {
      productTitle = first.title;
      previewProductTitleEls.forEach((el) => { el.textContent = first.title; });
      previewProductTitleShortEls.forEach((el) => { el.textContent = first.title.split(" ")[0] || first.title; });
      previewProductPriceEls.forEach((el) => { el.textContent = `${first.priceMinor.toLocaleString("vi-VN")} ${first.currency}`; });
      previewProductIconEls.forEach((el) => { el.textContent = PRESET_ICON_GLYPHS[first.icon] ?? "⚡"; });
      previewProductDescEls.forEach((el) => { el.textContent = first.description; });
      previewFulfillmentEls.forEach((el) => {
        el.textContent = first.fulfillmentType === "manual" ? "Giao thủ công" : "Tự động giao key";
      });
    }
  }

  function applyProductConfig(vertical: Vertical): void {
    const config = productConfig[vertical];
    if (!config || !productPane) return;
    setText("[data-product-hero-title]", config.heroTitle);
    setText("[data-product-hero-desc]", config.heroDesc);
    setText("[data-presets-sublabel]", config.presetsSublabel);
    setText("[data-product-submit-label]", config.submitLabel);
    setText("[data-fulfillment-label]", config.fulfillmentLabel);
    if (customTitleInput) {
      customTitleInput.placeholder = config.customTitlePlaceholder;
      customTitleInput.value = config.customTitleDefault;
    }
    if (customPriceInput) customPriceInput.value = String(config.priceDefault);
    if (customDescTextarea) {
      customDescTextarea.placeholder = config.customDescPlaceholder;
      customDescTextarea.value = config.customDescDefault;
    }
    if (customFulfillmentSelect) {
      const previous = customFulfillmentSelect.value;
      while (customFulfillmentSelect.firstChild) {
        customFulfillmentSelect.removeChild(customFulfillmentSelect.firstChild);
      }
      for (const option of config.fulfillmentOptions) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        customFulfillmentSelect.appendChild(el);
      }
      const stillPresent = config.fulfillmentOptions.some((option) => option.value === previous);
      customFulfillmentSelect.value = stillPresent ? previous : (config.fulfillmentOptions[0]?.value ?? "manual");
    }
    productPane.dataset.activeVertical = vertical;
  }

  function setText(selector: string, value: string): void {
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      el.textContent = value;
    });
  }

  // --- Step 3: per-vertical inventory config (OB-A3) ---
  const inventoryPane = root.querySelector<HTMLElement>('[data-step-pane="inventory"]');
  const inventoryConfig = parseJsonAttribute<Partial<Record<Vertical, InventoryStepConfig>>>(inventoryPane?.dataset.inventoryConfig, {});

  function applyInventoryConfig(vertical: Vertical): void {
    const config = inventoryConfig[vertical];
    if (!config || !inventoryPane) return;
    const keyless = vertical === "booking";
    inventoryPane.dataset.activeVertical = vertical;
    inventoryPane.querySelector<HTMLElement>("[data-inventory-keyless-panel]")?.toggleAttribute("hidden", !keyless);
    inventoryPane.querySelectorAll<HTMLElement>("[data-inventory-key-section]").forEach((el) => {
      el.hidden = keyless;
    });
    setText("[data-inv-hero-title]", config.heroTitle);
    setText("[data-inv-hero-desc]", config.heroDesc);
    setText("[data-inv-sample-btn]", config.sampleBtn);
    setText("[data-inv-or-separator]", config.orSeparator);
    setText("[data-inv-label]", config.label);
    setText("[data-inv-vault-note]", config.vaultNote);
    setText("[data-inv-metric-valid]", config.metricValid);
    setText("[data-inv-submit-label]", config.submitLabel);
    setText("[data-inv-skip-label]", config.skipLabel);
    const keysTextarea = root.querySelector<HTMLTextAreaElement>("[data-input-inventory-keys]");
    if (keysTextarea) keysTextarea.placeholder = config.placeholder;
    currentUnitBadge = config.unitBadge;
    updateKeyMetrics();
  }

  function setVertical(vertical: Vertical): void {
    currentVertical = vertical;
    root.querySelectorAll<HTMLElement>("[data-vertical-option]").forEach((card) => {
      card.classList.toggle("is-selected", card.dataset.verticalOption === vertical);
    });
    renderTemplateCards(vertical, selectedTemplateValue());
    renderPresetCards(vertical);
    applyProductConfig(vertical);
    applyInventoryConfig(vertical);
  }

  const verticalRadios = root.querySelectorAll<HTMLInputElement>("[data-vertical-radio]");
  verticalRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.value === "digital" || radio.value === "physical" || radio.value === "booking") {
        setVertical(radio.value);
      }
    });
  });

  modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      modeTabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      const presetsSection = root.querySelector<HTMLElement>("[data-presets-container]");
      currentProductMode = tab.dataset.productMode === "custom" ? "custom" : "preset";
      if (presetsSection && customProductForm) {
        presetsSection.hidden = currentProductMode !== "preset";
        customProductForm.hidden = currentProductMode !== "custom";
      }
    });
  });

  // Delegated preset card selection (cards re-render per vertical)
  presetsGrid?.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-preset-card]");
    if (!card || !presetsGrid.contains(card)) return;
    presetsGrid.querySelectorAll<HTMLElement>("[data-preset-card]").forEach((candidate) => {
      candidate.classList.toggle("selected", candidate === card);
    });
    selectedPresetId = card.dataset.presetCard || "";

    const title = card.dataset.presetTitle || "";
    const price = Number(card.dataset.presetPrice || 0);
    const icon = card.dataset.presetIcon || "zap";
    const desc = card.dataset.presetDesc || "";
    const fulfillment = card.dataset.presetFulfillment === "manual" ? "Giao thủ công" : "Tự động giao key";

    productTitle = title;
    previewProductTitleEls.forEach((el) => { el.textContent = title; });
    previewProductTitleShortEls.forEach((el) => { el.textContent = title.split(" ")[0] || title; });
    previewProductPriceEls.forEach((el) => { el.textContent = `${price.toLocaleString("vi-VN")} ${defaultCurrency}`; });
    previewProductIconEls.forEach((el) => { el.textContent = PRESET_ICON_GLYPHS[icon] ?? "⚡"; });
    previewProductDescEls.forEach((el) => { el.textContent = desc; });
    previewFulfillmentEls.forEach((el) => { el.textContent = fulfillment; });
  });

  customTitleInput?.addEventListener("input", () => {
    const val = customTitleInput.value.trim() || "Sản phẩm mới";
    previewProductTitleEls.forEach((el) => { el.textContent = val; });
    previewProductTitleShortEls.forEach((el) => { el.textContent = val; });
  });

  customPriceInput?.addEventListener("input", () => {
    const price = Number(customPriceInput.value || 0);
    previewProductPriceEls.forEach((el) => { el.textContent = `${price.toLocaleString("vi-VN")} ${defaultCurrency}`; });
  });

  customDescTextarea?.addEventListener("input", () => {
    const val = customDescTextarea.value.trim() || "";
    previewProductDescEls.forEach((el) => { el.textContent = val; });
  });

  // --- Step 1 submit: one-request provisioning (OB-B1) ---
  storeForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const name = nameInput?.value.trim() || "";
      const slug = slugInput?.value.trim() || slugify(name);

      if (!name || !slug) {
        if (nameInput && !name) {
          nameInput.setCustomValidity("Tên cửa hàng là bắt buộc.");
          nameInput.setAttribute("aria-invalid", "true");
          nameInput.focus();
          nameInput.reportValidity();
        }
        if (slugInput && !slug) {
          slugInput.setCustomValidity("Đường dẫn cửa hàng là bắt buộc.");
          slugInput.setAttribute("aria-invalid", "true");
          if (name) slugInput.focus();
        }
        showToast("Vui lòng nhập tên cửa hàng hợp lệ.", "error");
        return;
      }
      nameInput?.setCustomValidity("");
      nameInput?.removeAttribute("aria-invalid");
      slugInput?.setCustomValidity("");
      slugInput?.removeAttribute("aria-invalid");

      if (!creationAllowed && !activeShopPublicId) {
        showToast("Tài khoản cần hoàn tất thanh toán gói hiện tại trước khi tạo thêm cửa hàng.", "error");
        return;
      }

      const submitBtn = storeForm.querySelector<HTMLButtonElement>("[data-step-submit='store']");
      if (submitBtn) submitBtn.disabled = true;

      try {
        if (!activeShopPublicId) {
          // Single round-trip: shop + channels + storefront template land in
          // one transaction on the server.
          const selectedChannel = Array.from(channelRadios).find((r) => r.checked)?.value || "both";
          const shopPayload = JSON.stringify({
              channels: {
                customDomainPreference: "later",
                telegramEnabled: selectedChannel !== "website",
                websiteEnabled: selectedChannel !== "telegram",
              },
              currency: defaultCurrency,
              defaultLocale: "vi-VN",
              name,
              planCode: requestedPlanCode,
              slug,
              templateId: selectedTemplateValue() ?? undefined,
              vertical: currentVertical,
            });
          const shopIntentKey = await stableIntentKey("shop", shopPayload);
          const res = await apiRequest("/api/app/shops", {
            body: shopPayload,
            headers: {
              "Idempotency-Key": shopIntentKey,
            },
            method: "POST",
          });

          if (!res.ok) {
            const issues = Array.isArray(res.data.issues) ? res.data.issues.map(String) : [];
            if (issues.includes("storefront_template_premium_required")) {
              showToast("Giao diện PRO cần gói Pro — hãy chọn giao diện chuẩn hoặc nâng cấp sau trong Thanh toán.", "error");
            } else if (issues.includes("slug_unavailable")) {
              showToast("Địa chỉ web đã có người dùng — vui lòng chọn đường dẫn khác.", "error");
            } else {
              showToast("Không thể tạo cửa hàng. Vui lòng kiểm tra lại slug hoặc kết nối mạng.", "error");
            }
            if (submitBtn) submitBtn.disabled = false;
            return;
          }

          const shopData = res.data as ShopResponse;
          activeShopPublicId = shopData.shop?.publicId ?? "";
          activeShopName = shopData.shop?.name ?? name;
          activeShopSlug = shopData.shop?.slug ?? slug;
          clearStableIntent("shop");
        } else {
          // Existing shop: persist the profile before changing the wizard step.
          const profilePayload = JSON.stringify({ name, slug });
          const profileRes = await apiRequest(`/api/app/shops/${encodeURIComponent(activeShopPublicId)}`, {
            body: profilePayload,
            headers: { "Idempotency-Key": await stableIntentKey(`profile:${activeShopPublicId}`, profilePayload) },
            method: "PATCH",
          });
          if (!profileRes.ok) {
            showToast("Không thể lưu tên hoặc đường dẫn cửa hàng.", "error");
            return;
          }
          const profileShop = (profileRes.data as ShopResponse).shop;
          activeShopName = profileShop?.name ?? name;
          activeShopSlug = profileShop?.slug ?? slug;
          clearStableIntent(`profile:${activeShopPublicId}`);

          // Existing shop: update channels + template through their endpoints.
          const selectedChannel = Array.from(channelRadios).find((r) => r.checked)?.value || "both";
          const channelsPayload = JSON.stringify({
              customDomainPreference: "later",
              telegramEnabled: selectedChannel !== "website",
              websiteEnabled: selectedChannel !== "telegram",
            });
          const channelsRes = await apiRequest(`/api/app/shops/${encodeURIComponent(activeShopPublicId)}/onboarding/channels`, {
            body: channelsPayload,
            headers: { "Idempotency-Key": await stableIntentKey(`channels:${activeShopPublicId}`, channelsPayload) },
            method: "PUT",
          });
          if (!channelsRes.ok) {
            showToast("Không thể lưu kênh bán hàng. Vui lòng thử lại.", "error");
            return;
          }
          clearStableIntent(`channels:${activeShopPublicId}`);
          const chosenTemplate = selectedTemplateValue();
          if (chosenTemplate !== null) {
            // Use the server-known draft version from the resume projection;
            // fall back to 1 for fresh drafts created outside this wizard.
            const settingsRes = await apiRequest(`/api/app/shops/${encodeURIComponent(activeShopPublicId)}/settings`, {
              body: JSON.stringify({ expectedVersion: storefrontVersion, templateId: chosenTemplate }),
              method: "PATCH",
            });
            if (!settingsRes.ok) {
              showToast("Không thể lưu giao diện cửa hàng. Vui lòng thử lại.", "error");
              return;
            }
            const settingsVersion = (settingsRes.data as StorefrontSettingsResponse).settings?.version;
            if (typeof settingsVersion === "number" && Number.isSafeInteger(settingsVersion) && settingsVersion >= 1) {
              storefrontVersion = settingsVersion;
            }
          }
        }

        activeShopSlug = activeShopSlug || slug;
        activeShopName = activeShopName || name;

        showToast("Đã lưu thông tin cửa hàng thành công!");
        setStep("product");
      } catch {
        showToast("Có lỗi xảy ra khi lưu thông tin cửa hàng.", "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    })();
  });

  // --- Step 2 submit: presets seed everything, custom follows vertical (OB-A3/B3) ---
  const productSubmitBtn = root.querySelector<HTMLButtonElement>("[data-step-submit='product']");
  productSubmitBtn?.addEventListener("click", () => {
    void (async () => {
      if (!activeShopPublicId) {
        showToast("Vui lòng hoàn thành bước tạo cửa hàng trước.", "error");
        setStep("store");
        return;
      }

      productSubmitBtn.disabled = true;

      try {
        if (currentProductMode === "preset") {
          const presetPayload = JSON.stringify({ presetId: selectedPresetId });
          const presetIntentNamespace = `preset:${activeShopPublicId}`;
          const res = await apiRequest(
            `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/onboarding/seed-preset`,
            {
              body: presetPayload,
              headers: { "Idempotency-Key": await stableIntentKey(presetIntentNamespace, presetPayload) },
              method: "POST",
            },
          );

          if (!res.ok) {
            const issues = Array.isArray(res.data.issues) ? res.data.issues.map(String) : [];
            if (issues.includes("preset_vertical_mismatch")) {
              showToast("Mẫu sản phẩm không thuộc danh mục cửa hàng — hãy chọn lại mẫu.", "error");
            } else {
              showToast("Không thể tạo sản phẩm mẫu. Vui lòng thử lại.", "error");
            }
            productSubmitBtn.disabled = false;
            return;
          }

          const seedData = res.data as SeedResponse;
          createdVariantId = seedData.variant?.id ?? "";
          importedKeysCount = seedData.importedKeysCount ?? 0;
          productIsManual = seedData.product?.fulfillmentType === "manual";
          clearStableIntent(presetIntentNamespace);
          // Manual presets need no vault. License-key presets must collect real
          // encrypted inventory unless a private deployment seeded it server-side.
          showToast(importedKeysCount > 0
            ? `Đã tạo sản phẩm và nạp ${String(importedKeysCount)} key mẫu — nhập thêm key sau trong Dashboard!`
            : "Đã tạo sản phẩm mẫu thành công!");
          setStep(productIsManual || importedKeysCount > 0 ? "connect" : "inventory");
        } else {
          const title = customTitleInput?.value.trim() || "Sản phẩm mới";
          const price = Number(customPriceInput?.value || 0);
          const fulfillmentType = customFulfillmentSelect?.value || "manual";
          const description = customDescTextarea?.value.trim() || "";
          productTitle = title;

          const productIntentNamespace = `product:${activeShopPublicId}`;
          const productIdentityPayload = JSON.stringify({ description, fulfillmentType, price, title });
          const productSuffix = await stableDigestSuffix(productIdentityPayload, 8);
          const productSlugBase = slugify(title) || "san-pham";

          const productPayload = JSON.stringify({
            data: {
              categoryId: null,
              description,
              fulfillmentType,
              slug: `${productSlugBase}-${productSuffix}`,
              status: "active",
              title,
            },
            initialVariant: {
              currency: defaultCurrency,
              maxPerOrder: 10,
              minPerOrder: 1,
              priceMinor: price,
              sku: `SKU-${productSuffix.toUpperCase()}`,
              status: "active",
              title: "Mặc định",
            },
          });
          const res = await apiRequest(
            `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/products`,
            {
              body: productPayload,
              headers: {
                "Idempotency-Key": await stableIntentKey(productIntentNamespace, productPayload),
              },
              method: "POST",
            },
          );

          if (!res.ok) {
            showToast("Không thể tạo sản phẩm. Vui lòng kiểm tra lại thông tin.", "error");
            productSubmitBtn.disabled = false;
            return;
          }

          const prodData = res.data as ProductCreateResponse;
          createdVariantId = prodData.variant?.id ?? "";
          productIsManual = fulfillmentType === "manual";
          clearStableIntent(productIntentNamespace);
          showToast("Đã tạo sản phẩm thành công!");
          // Digital license products still need keys; everything else skips
          // the vault and moves to connections.
          setStep(fulfillmentType === "license_key" ? "inventory" : "connect");
        }
      } catch {
        showToast("Có lỗi xảy ra khi tạo sản phẩm.", "error");
      } finally {
        productSubmitBtn.disabled = false;
      }
    })();
  });

  // --- Step 3: Inventory keys / serial codes ---
  const keysTextarea = root.querySelector<HTMLTextAreaElement>("[data-input-inventory-keys]");
  const countBadge = root.querySelector<HTMLElement>("[data-inventory-count-badge]");
  const totalMetric = root.querySelector<HTMLElement>("[data-metric-total]");
  const validMetric = root.querySelector<HTMLElement>("[data-metric-valid]");
  const dupMetric = root.querySelector<HTMLElement>("[data-metric-duplicate]");
  const genSampleKeysBtn = root.querySelector<HTMLButtonElement>("[data-action-generate-sample-keys]");
  const skipInventoryBtn = root.querySelector<HTMLButtonElement>("[data-step-skip='inventory']");
  const inventorySubmitBtn = root.querySelector<HTMLButtonElement>("[data-step-submit='inventory']");

  function updateKeyMetrics(): void {
    const raw = keysTextarea?.value || "";
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const unique = new Set(lines);
    const total = lines.length;
    const valid = unique.size;
    const dups = total - valid;

    if (countBadge) countBadge.textContent = `${String(valid)} ${currentUnitBadge}`;
    if (totalMetric) totalMetric.textContent = String(total);
    if (validMetric) validMetric.textContent = String(valid);
    if (dupMetric) dupMetric.textContent = String(dups);
  }

  keysTextarea?.addEventListener("input", updateKeyMetrics);

  genSampleKeysBtn?.addEventListener("click", () => {
    const prefix = currentVertical === "physical" ? "UNIT" : "WIN11-PRO";
    const samples = Array.from({ length: 5 }, () => {
      const segment = () => Math.random().toString(36).slice(2, 7).toUpperCase();
      return `${prefix}-${segment()}-${segment()}`;
    });
    if (keysTextarea) {
      keysTextarea.value = samples.join("\n");
      updateKeyMetrics();
      showToast("Đã tạo 5 mã thử nghiệm!");
    }
  });

  skipInventoryBtn?.addEventListener("click", () => {
    setStep("connect");
  });

  inventorySubmitBtn?.addEventListener("click", () => {
    void (async () => {
      const keysData = keysTextarea?.value.trim() || "";
      if (!keysData) {
        setStep("connect");
        return;
      }

      if (!activeShopPublicId || !createdVariantId) {
        setStep("connect");
        return;
      }

      inventorySubmitBtn.disabled = true;

      try {
        // Preview
        const previewRes = await apiRequest(
          `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/variants/${encodeURIComponent(createdVariantId)}/inventory/preview`,
          {
            body: JSON.stringify({ data: keysData, filename: null, source: "paste" }),
            method: "POST",
          },
        );

        if (!previewRes.ok) {
          showToast("Không thể phân tích dữ liệu key. Vui lòng kiểm tra lại.", "error");
          inventorySubmitBtn.disabled = false;
          return;
        }

        const previewData = previewRes.data as InventoryPreviewResponse;
        const previewToken = previewData.previewToken ?? "";

        // Confirm Import
        const inventoryIntentNamespace = `inventory:${activeShopPublicId}:${createdVariantId}`;
        const inventoryIntentPayload = JSON.stringify({ data: keysData, filename: null, source: "paste" });
        const importRes = await apiRequest(
          `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/variants/${encodeURIComponent(createdVariantId)}/inventory/import`,
          {
            body: JSON.stringify({
              data: keysData,
              filename: null,
              previewToken,
              source: "paste",
            }),
            headers: {
              "Idempotency-Key": await stableIntentKey(inventoryIntentNamespace, inventoryIntentPayload),
            },
            method: "POST",
          },
        );

        if (importRes.ok) {
          const importData = importRes.data as InventoryImportResponse;
          const accepted = importData.acceptedCount ?? 0;
          importedKeysCount += accepted;
          clearStableIntent(inventoryIntentNamespace);
          showToast(`Đã mã hóa và nạp ${String(accepted)} mã vào kho an toàn!`);
          setStep("connect");
        } else {
          showToast("Có lỗi xảy ra khi nạp mã vào kho.", "error");
        }
      } catch {
        showToast("Có lỗi xảy ra khi nạp mã.", "error");
      } finally {
        inventorySubmitBtn.disabled = false;
      }
    })();
  });

  // --- Step 4: PayOS & Telegram Connections ---
  const payosForm = root.querySelector<HTMLFormElement>("[data-payos-form]");
  const payosStatusPill = root.querySelector<HTMLElement>("[data-payos-status-pill]");
  const tgForm = root.querySelector<HTMLFormElement>("[data-telegram-form]");
  const tgStatusPill = root.querySelector<HTMLElement>("[data-telegram-status-pill]");
  const launchBtn = root.querySelector<HTMLButtonElement>("[data-step-submit='connect']");
  const skipConnectBtn = root.querySelector<HTMLButtonElement>("[data-step-skip='connect']");

  // Per-card "skip for now"
  root.querySelectorAll<HTMLButtonElement>("[data-card-skip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest<HTMLElement>(".connect-card");
      if (!card) return;
      card.classList.add("is-skipped");
      card.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
        input.disabled = true;
      });
      const pill = card.querySelector<HTMLElement>("[data-payos-status-pill], [data-telegram-status-pill]");
      if (pill) {
        pill.dataset.status = "skipped";
        pill.textContent = "Sẽ kết nối sau";
      }
      btn.hidden = true;
    });
  });

  payosForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const clientId = (root.querySelector<HTMLInputElement>("[data-input-payos-client-id]")?.value || "").trim();
      const apiKey = (root.querySelector<HTMLInputElement>("[data-input-payos-api-key]")?.value || "").trim();
      const checksumKey = (root.querySelector<HTMLInputElement>("[data-input-payos-checksum-key]")?.value || "").trim();

      if (!clientId || !apiKey || !checksumKey) {
        showToast("Vui lòng điền đủ 3 thông số Client ID, API Key, Checksum Key.", "error");
        return;
      }

      const verifyBtn = payosForm.querySelector<HTMLButtonElement>("[data-btn-verify-payos]");
      if (verifyBtn) verifyBtn.disabled = true;

      try {
        const res = await apiRequest(`/api/app/shops/${encodeURIComponent(activeShopPublicId)}/payments/payos`, {
          body: JSON.stringify({ apiKey, checksumKey, clientId }),
          method: "PUT",
        });

        if (res.ok) {
          payosVerified = true;
          if (payosStatusPill) {
            payosStatusPill.dataset.status = "verified";
            payosStatusPill.textContent = "✓ Đã xác thực";
          }
          showToast("Kết nối cổng thanh toán PayOS thành công!");
        } else {
          if (payosStatusPill) {
            payosStatusPill.dataset.status = "error";
            payosStatusPill.textContent = "Lỗi kết nối";
          }
          showToast("Thông số PayOS không chính xác hoặc không kết nối được.", "error");
        }
      } catch {
        showToast("Lỗi xác thực PayOS.", "error");
      } finally {
        if (verifyBtn) verifyBtn.disabled = false;
      }
    })();
  });

  tgForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const botToken = (root.querySelector<HTMLInputElement>("[data-input-telegram-token]")?.value || "").trim();
      if (!botToken) {
        showToast("Vui lòng dán HTTP API Token của bot.", "error");
        return;
      }

      const verifyBtn = tgForm.querySelector<HTMLButtonElement>("[data-btn-verify-telegram]");
      if (verifyBtn) verifyBtn.disabled = true;

      try {
        const res = await apiRequest(
          `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/integrations/telegram`,
          {
            body: JSON.stringify({ botToken }),
            method: "PUT",
          },
        );

        const tgData = res.data as TelegramResponse;
        const botUser = tgData.integration?.bot?.username ?? "";

        if (res.ok && botUser) {
          telegramConnected = true;
          telegramBotUser = botUser;
          if (tgStatusPill) {
            tgStatusPill.dataset.status = "verified";
            tgStatusPill.textContent = `✓ Đã kết nối @${botUser}`;
          }
          showToast(`Kết nối Bot @${botUser} thành công!`);
        } else {
          if (tgStatusPill) {
            tgStatusPill.dataset.status = "error";
            tgStatusPill.textContent = "Token không hợp lệ";
          }
          showToast("Token Telegram không hợp lệ hoặc chưa được kích hoạt.", "error");
        }
      } catch {
        showToast("Lỗi kết nối Telegram.", "error");
      } finally {
        if (verifyBtn) verifyBtn.disabled = false;
      }
    })();
  });

  skipConnectBtn?.addEventListener("click", () => {
    setStep("launch");
  });

  launchBtn?.addEventListener("click", () => {
    setStep("launch");
  });

  // --- Step 5: Launch review, settings & publish ---
  const launchSettingsForm = root.querySelector<HTMLFormElement>("[data-launch-settings-form]");
  const saveSettingsBtn = root.querySelector<HTMLButtonElement>("[data-btn-save-settings]");
  const publishBtn = root.querySelector<HTMLButtonElement>("[data-step-submit='launch']");
  const launchReview = root.querySelector<HTMLElement>("[data-launch-review]");
  const launchCelebration = root.querySelector<HTMLElement>("[data-launch-celebration]");

  function refreshLaunchState(): void {
    // Summary cards
    const shopEl = root.querySelector<HTMLElement>("[data-launch-summary-shop]");
    const slugEl = root.querySelector<HTMLElement>("[data-launch-summary-slug]");
    const productEl = root.querySelector<HTMLElement>("[data-launch-summary-product]");
    const keysEl = root.querySelector<HTMLElement>("[data-launch-summary-keys]");
    const payosEl = root.querySelector<HTMLElement>("[data-launch-summary-payos]");
    const telegramEl = root.querySelector<HTMLElement>("[data-launch-summary-telegram]");

    if (shopEl) shopEl.textContent = activeShopName || "Cửa hàng của bạn";
    if (slugEl) slugEl.textContent = activeShopSlug ? `${activeShopSlug}.${platformBaseDomain}` : "—";
    if (productEl) productEl.textContent = productTitle || (createdVariantId ? "Đã tạo" : "Chưa tạo");
    if (keysEl) keysEl.textContent = productIsManual
      ? "Giao thủ công — không cần kho"
      : `${String(importedKeysCount)} mã trong kho`;

    const payosCard = root.querySelector<HTMLElement>("[data-launch-card-payos]");
    if (payosEl) payosEl.textContent = payosVerified ? "✓ Đã xác thực" : "Chưa kết nối";
    payosCard?.classList.toggle("is-ready", payosVerified);

    const telegramCard = root.querySelector<HTMLElement>("[data-launch-card-telegram]");
    if (telegramEl) telegramEl.textContent = telegramConnected ? `✓ @${telegramBotUser}` : "Chưa kết nối";
    telegramCard?.classList.toggle("is-ready", telegramConnected);

    // Checklist
    const checks: Record<string, boolean> = {
      inventory: productIsManual || importedKeysCount > 0,
      payos: payosVerified,
      product: createdVariantId !== "",
      shop: activeShopPublicId !== "",
      telegram: telegramConnected,
    };
    root.querySelectorAll<HTMLElement>("[data-launch-check]").forEach((row) => {
      const key = row.dataset.launchCheck ?? "";
      row.classList.toggle("is-done", checks[key] === true);
    });
  }

  launchSettingsForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      if (!activeShopPublicId) {
        showToast("Vui lòng hoàn thành bước tạo cửa hàng trước.", "error");
        return;
      }

      const support = (root.querySelector<HTMLInputElement>("[data-input-launch-support]")?.value || "").trim();
      const terms = (root.querySelector<HTMLInputElement>("[data-input-launch-terms]")?.value || "").trim();
      const privacy = (root.querySelector<HTMLInputElement>("[data-input-launch-privacy]")?.value || "").trim();
      const refund = (root.querySelector<HTMLInputElement>("[data-input-launch-refund]")?.value || "").trim();

      if (saveSettingsBtn) saveSettingsBtn.disabled = true;

      try {
        const res = await apiRequest(
          `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/onboarding/settings`,
          {
            body: JSON.stringify({
              attestationAccepted: false,
              attestationVersion: null,
              privacyUrl: privacy || null,
              refundPolicyUrl: refund || null,
              supportContact: support || null,
              termsUrl: terms || null,
            }),
            method: "PUT",
          },
        );

        if (res.ok) {
          const settingsVersion = (res.data as StorefrontSettingsResponse).settings?.version;
          if (typeof settingsVersion === "number" && Number.isSafeInteger(settingsVersion) && settingsVersion >= 1) {
            storefrontVersion = settingsVersion;
          }
          showToast("Đã lưu thông tin liên hệ & chính sách.");
        } else {
          showToast("Không lưu được thông tin. Kiểm tra lại các đường dẫn HTTPS.", "error");
        }
      } catch {
        showToast("Có lỗi xảy ra khi lưu thông tin.", "error");
      } finally {
        if (saveSettingsBtn) saveSettingsBtn.disabled = false;
      }
    })();
  });

  function completeAndCelebrate(): void {
    const storefrontLink = root.querySelector<HTMLAnchorElement>("[data-celebration-storefront-link]");
    const slugDisplay = root.querySelector<HTMLElement>("[data-celebration-slug-display]");
    const dashboardLink = root.querySelector<HTMLAnchorElement>("[data-celebration-dashboard-link]");
    const telegramLink = root.querySelector<HTMLAnchorElement>("[data-celebration-telegram-link]");
    const telegramDisplay = root.querySelector<HTMLElement>("[data-celebration-bot-display]");

    const finalSlug = activeShopSlug || "cua-hang";
    if (storefrontLink && slugDisplay) {
      storefrontLink.href = `https://${finalSlug}.${platformBaseDomain}`;
      slugDisplay.textContent = `https://${finalSlug}.${platformBaseDomain}`;
    }
    if (dashboardLink && activeShopPublicId) {
      dashboardLink.href = `/app?shop=${encodeURIComponent(activeShopPublicId)}`;
    }
    if (telegramLink && telegramConnected && telegramBotUser) {
      telegramLink.href = `https://t.me/${telegramBotUser}`;
      telegramLink.hidden = false;
      if (telegramDisplay) telegramDisplay.textContent = `@${telegramBotUser}`;
    }

    if (launchReview) launchReview.hidden = true;
    if (launchCelebration) launchCelebration.hidden = false;
    triggerConfetti();
  }

  publishBtn?.addEventListener("click", () => {
    void (async () => {
      publishBtn.disabled = true;
      let published = false;
      try {
        if (activeShopPublicId) {
          const res = await apiRequest(
            `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/storefront/publish`,
            { body: JSON.stringify({ expectedVersion: storefrontVersion }), method: "POST" },
          );
          if (res.ok && publishedProjection(res.data)) {
            published = true;
            showToast("Chúc mừng! Cửa hàng của bạn đã chính thức mở bán!");
          } else {
            showToast("Cửa hàng đã lưu nhưng chưa publish được — bạn có thể kích hoạt lại từ Dashboard.", "error");
          }
        } else {
          showToast("Chưa có cửa hàng để publish.", "error");
        }
      } catch {
        showToast("Không kết nối được máy chủ — tiến trình vẫn được lưu.", "error");
      } finally {
        publishBtn.disabled = false;
      }
      if (published) completeAndCelebrate();
    })();
  });

  // --- Back navigation buttons ---
  root.querySelectorAll<HTMLButtonElement>("[data-step-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.stepBack as WizardStep;
      setStep(target);
    });
  });

  // --- Initial state ---
  const initialVerticalFromDom = productPane?.dataset.activeVertical;
  currentVertical = initialVerticalFromDom === "physical" || initialVerticalFromDom === "booking" ? initialVerticalFromDom : "digital";

  // OB-B4: hydrate the wizard from the server resume projection so refreshes
  // and returning sellers re-enter at the first unfinished step.
  if (resume !== null) {
    activeShopPublicId = activeShopPublicId || root.dataset.activeShopPublicId || "";
    activeShopSlug = resume.shop.slug;
    activeShopName = resume.shop.name;
    currentVertical = resume.shop.vertical;
    createdVariantId = resume.catalog.firstVariantId ?? "";
    productTitle = resume.catalog.firstVariantTitle ?? "";
    productIsManual = resume.catalog.hasManualProduct;
    importedKeysCount = resume.catalog.totalAvailableStock;
    payosVerified = resume.integrations.payosReady;
    telegramConnected = resume.integrations.telegramReady;
    telegramBotUser = resume.integrations.telegramBotUsername ?? "";
    // Reflect the persisted channel choice so re-submitting step 1 for an
    // existing shop can never silently flip channels back to "both".
    const resumedChannel = resume.channels.websiteEnabled && resume.channels.telegramEnabled
      ? "both"
      : resume.channels.telegramEnabled ? "telegram" : "website";
    const channelRadio = Array.from(channelRadios).find((radio) => radio.value === resumedChannel);
    if (channelRadio) {
      channelRadio.checked = true;
      channelRadio.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (payosVerified && payosStatusPill) {
      payosStatusPill.dataset.status = "verified";
      payosStatusPill.textContent = "✓ Đã xác thực";
    }
    if (telegramConnected && tgStatusPill) {
      tgStatusPill.dataset.status = "verified";
      tgStatusPill.textContent = `✓ Đã kết nối @${telegramBotUser}`;
    }
    // Re-render data-driven groups for the resumed vertical + template.
    renderTemplateCards(currentVertical, resume.shop.templateId);
    renderPresetCards(currentVertical);
    applyProductConfig(currentVertical);
    applyInventoryConfig(currentVertical);
  } else {
    selectedPresetId = (presetsMap[currentVertical] ?? [])[0]?.id ?? "";
  }

  const initialPane = root.querySelector<HTMLElement>(`[data-step-pane="${currentStep}"]`);
  initialPane?.classList.add("is-active");
  updateProgress();

  if (resume !== null && STEP_ORDER.includes(resume.wizardStep) && resume.wizardStep !== "store") {
    setStep(resume.wizardStep);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initQuickstart);
} else {
  initQuickstart();
}
