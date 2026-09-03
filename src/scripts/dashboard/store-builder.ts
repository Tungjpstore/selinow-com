import { MIN_STOREFRONT_CONTRAST, validateStorefrontContrast, type StorefrontContrastValidation } from "./store-builder-contrast";

type StorefrontDraft = {
  accentColor: string;
  announcement: string;
  deliveryText: string;
  description: string;
  footerText: string;
  headline: string;
  logoUrl: string;
  primaryColor: string;
  seoDescription: string;
  seoTitle: string;
  sections?: unknown;
  showExactStock: boolean;
  supportText: string;
  templateId: string;
};

type StorefrontSettingsResponse = {
  settings: {
    publicationState: "never_published" | "published" | "unpublished_changes";
    version: number;
  };
};

type JsonObject = Record<string, unknown>;

const builder = document.querySelector<HTMLElement>("[data-store-builder]");

if (builder !== null) {
  const copy = (() => {
    try {
      const parsed: unknown = JSON.parse(builder.dataset.copy ?? "{}");
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  })();
  const text = (key: string, replacements: Record<string, string> = {}): string => {
    let value = copy[key] ?? "";
    for (const [name, replacement] of Object.entries(replacements)) value = value.replaceAll(`__${name.toUpperCase()}__`, replacement);
    return value;
  };
  const parseInitialDraft = (value: string | undefined): StorefrontDraft | null => {
    if (value === undefined || value.length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "object" || parsed === null) return null;
      const draft = parsed as Partial<StorefrontDraft>;
      if (typeof draft.accentColor !== "string"
        || typeof draft.deliveryText !== "string"
        || typeof draft.description !== "string"
        || typeof draft.footerText !== "string"
        || typeof draft.headline !== "string"
        || typeof draft.primaryColor !== "string"
        || typeof draft.seoDescription !== "string"
        || typeof draft.seoTitle !== "string"
        || typeof draft.showExactStock !== "boolean"
        || typeof draft.supportText !== "string"
        || typeof draft.templateId !== "string") return null;
      return {
        accentColor: draft.accentColor,
        announcement: typeof draft.announcement === "string" ? draft.announcement : "",
        deliveryText: draft.deliveryText,
        description: draft.description,
        footerText: draft.footerText,
        headline: draft.headline,
        logoUrl: typeof draft.logoUrl === "string" ? draft.logoUrl : "",
        primaryColor: draft.primaryColor,
        seoDescription: draft.seoDescription,
        seoTitle: draft.seoTitle,
        sections: draft.sections,
        showExactStock: draft.showExactStock,
        supportText: draft.supportText,
        templateId: draft.templateId,
      };
    } catch {
      return null;
    }
  };

  const initialDraft = parseInitialDraft(builder.dataset.initialDraft);
  const initialVersion = Number(builder.dataset.draftVersion);
  if (initialDraft === null || !Number.isSafeInteger(initialVersion) || initialVersion < 1) {
    builder.dataset.state = "invalid";
  } else {
    const canManage = builder.dataset.canManage === "true";
    const canPublish = builder.dataset.canPublish === "true";
    const shopPublicId = builder.dataset.shopPublicId ?? "";
    const csrfCookieName = builder.dataset.csrfCookieName ?? "";
    let saved: StorefrontDraft = { ...initialDraft };
    let draftVersion = initialVersion;
    let publicationState = builder.dataset.publicationState === "published"
      ? "published" as const
      : builder.dataset.publicationState === "unpublished_changes"
        ? "unpublished_changes" as const
        : "never_published" as const;

    const field = (name: keyof StorefrontDraft): HTMLInputElement | HTMLTextAreaElement | null =>
      builder.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${name}"]`);
    const feedback = builder.querySelector<HTMLElement>("[data-feedback]");
    const saveState = document.querySelector<HTMLElement>("[data-save-state]");
    const saveButton = builder.querySelector<HTMLButtonElement>("[data-save]");
    const undoButton = builder.querySelector<HTMLButtonElement>("[data-undo]");
    const publishButton = document.querySelector<HTMLButtonElement>("[data-publish]");
    const publicationBadge = builder.querySelector<HTMLElement>("[data-publication-badge] .sln-status");
    const contrast = builder.querySelector<HTMLElement>("[data-contrast]");
    const mobileViewTabs = [...builder.querySelectorAll<HTMLButtonElement>("[data-builder-view-tab]")];

    const readCookie = (name: string): string | null => {
      const raw = document.cookie.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`))
        ?.slice(name.length + 1);
      if (raw === undefined) return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    };

    const readSectionsField = (fallback: unknown): unknown => {
      try {
        const raw = field("sections")?.value ?? "";
        if (raw.trim() === "") return fallback;
        return JSON.parse(raw) as unknown;
      } catch {
        return fallback;
      }
    };

    const readDraft = (): StorefrontDraft => {
      const stockField = field("showExactStock");
      const templateField = builder.querySelector<HTMLInputElement>('[data-field="templateId"]:checked');
      return {
        accentColor: field("accentColor")?.value.toUpperCase() ?? saved.accentColor,
        announcement: field("announcement")?.value.trim() ?? "",
        deliveryText: field("deliveryText")?.value.trim() ?? "",
        description: field("description")?.value.trim() ?? "",
        footerText: field("footerText")?.value.trim() ?? "",
        headline: field("headline")?.value.trim() ?? "",
        logoUrl: field("logoUrl")?.value.trim() ?? "",
        primaryColor: field("primaryColor")?.value.toUpperCase() ?? saved.primaryColor,
        seoDescription: field("seoDescription")?.value.trim() ?? "",
        seoTitle: field("seoTitle")?.value.trim() ?? "",
        sections: readSectionsField(saved.sections),
        showExactStock: stockField instanceof HTMLInputElement ? stockField.checked : saved.showExactStock,
        supportText: field("supportText")?.value.trim() ?? "",
        templateId: templateField?.value ?? saved.templateId,
      };
    };

    const setTemplateSelection = (templateId: string): void => {
      builder.querySelectorAll<HTMLInputElement>('[data-field="templateId"]').forEach((radio) => {
        radio.checked = radio.value === templateId;
      });
    };

    const setState = (state: string): void => {
      if (saveState === null) return;
      const labels: Record<string, string> = {
        failed: text("failed"),
        forbidden: text("forbidden"),
        never_published: text("neverPublished"),
        published: text("published"),
        publishing: text("publishing"),
        saving: text("saving"),
        unsaved: text("unsaved"),
        unpublished_changes: text("unpublishedChanges"),
        invalid_contrast: text("invalidContrast"),
      };
      saveState.dataset.state = state;
      saveState.textContent = labels[state] ?? state;
    };

    const setFeedback = (message: string): void => {
      if (feedback !== null) feedback.textContent = message;
    };

    // Reads the owner-scoped readiness projection and lists every failed
    // required check so the seller sees WHY publishing is blocked.
    const renderPublishBlockers = async (): Promise<void> => {
      if (feedback === null || !shopPublicId) return;
      try {
        const response = await fetch(`/api/app/shops/${encodeURIComponent(shopPublicId)}/readiness`, { credentials: "same-origin" });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || typeof payload !== "object" || payload === null) return;
        const run: unknown = (payload as JsonObject).run;
        const checks: unknown = typeof run === "object" && run !== null ? (run as JsonObject).checks : null;
        if (!Array.isArray(checks)) return;
        const blockers = checks.filter((item): item is JsonObject => typeof item === "object" && item !== null
          && (item as JsonObject).status === "fail"
          && (item as JsonObject).required === true
          && typeof (item as JsonObject).code === "string");
        if (blockers.length === 0) return;
        const labels: unknown = copy.readinessCheckLabels;
        const list = document.createElement("ul");
        list.className = "publish-blockers";
        for (const check of blockers) {
          const item = document.createElement("li");
          const code = String(check.code);
          const label = typeof labels === "object" && labels !== null && typeof (labels as JsonObject)[code] === "string"
            ? (labels as JsonObject)[code] as string
            : code;
          item.textContent = label;
          list.appendChild(item);
        }
        feedback.appendChild(list);
      } catch {
        // Blocker detail is best-effort; the readiness_failed notice stands.
      }
    };

    const updatePublicationBadge = (): void => {
      if (publicationBadge === null) return;
      const label = publicationState === "published"
        ? text("live")
        : publicationState === "never_published" ? text("neverPublished") : text("unpublishedChanges");
      const dot = publicationBadge.querySelector<HTMLElement>("[aria-hidden='true']");
      publicationBadge.replaceChildren(...(dot === null ? [] : [dot]), document.createTextNode(label));
      publicationBadge.dataset.tone = publicationState === "published" ? "success" : "warning";
    };

    const contrastMessage = (validation: StorefrontContrastValidation): string => {
      const invalid = [
        [text("brandLabel"), validation.brand] as const,
        [text("accentLabel"), validation.accent] as const,
      ].filter(([, result]) => !result.valid);
      if (invalid.length === 0) {
        return text("contrastValid", { brand: validation.brand.ratio.toFixed(2), accent: validation.accent.ratio.toFixed(2) });
      }
      return text("contrastInvalid", {
        details: invalid.map(([label, result]) => `${label} ${result.ratio.toFixed(2)}:1`).join(", "),
        minimum: MIN_STOREFRONT_CONTRAST.toFixed(1),
      });
    };

    const updateContrast = (next: StorefrontDraft): StorefrontContrastValidation => {
      const validation = validateStorefrontContrast(next.primaryColor, next.accentColor);
      field("primaryColor")?.setAttribute("aria-invalid", String(!validation.brand.valid));
      field("accentColor")?.setAttribute("aria-invalid", String(!validation.accent.valid));
      if (contrast !== null) {
        contrast.dataset.tone = validation.valid ? "success" : "danger";
        const text = contrast.querySelector("p");
        if (text !== null) text.textContent = contrastMessage(validation);
      }
      return validation;
    };

    const updatePreview = (next: StorefrontDraft = readDraft()): StorefrontContrastValidation => {
      const root = builder.querySelector<HTMLElement>("[data-preview-surface]");
      const headline = builder.querySelector<HTMLElement>("[data-preview-headline]");
      const description = builder.querySelector<HTMLElement>("[data-preview-description]");
      const delivery = builder.querySelector<HTMLElement>("[data-preview-delivery]");
      const announcement = builder.querySelector<HTMLElement>("[data-preview-announcement]");
      const support = builder.querySelector<HTMLElement>("[data-preview-support]");
      const footer = builder.querySelector<HTMLElement>("[data-preview-footer]");
      const logo = builder.querySelector<HTMLElement>("[data-preview-logo]");
      const previewStockNodes = [...builder.querySelectorAll<HTMLElement>("[data-preview-stock]")];
      const validation = updateContrast(next);
      if (root !== null) {
        root.style.setProperty("--preview-brand", next.primaryColor);
        root.style.setProperty("--preview-accent", next.accentColor);
        root.style.setProperty("--preview-brand-ink", validation.brand.ink);
        root.style.setProperty("--preview-accent-ink", validation.accent.ink);
        // Per-template preview skin (CD4): the draft templateId re-skins the
        // live preview without a round-trip; swift is the unscoped default.
        root.dataset.templatePreview = next.templateId;
      }
      if (headline !== null) headline.textContent = next.headline || text("headlineFallback");
      if (description !== null) description.textContent = next.description || text("descriptionFallback");
      if (delivery !== null) delivery.textContent = next.deliveryText || text("deliveryFallback");
      if (support !== null) support.textContent = next.supportText || text("supportFallback");
      if (footer !== null) footer.textContent = next.footerText || text("footerFallback");
      for (const stockNode of previewStockNodes) {
        const state = stockNode.dataset.stockState;
        const exact = Number(stockNode.dataset.availableStock);
        stockNode.textContent = next.showExactStock && Number.isSafeInteger(exact)
          ? exact > 0 ? text("stockExact", { count: String(exact) }) : text("stockOut")
          : state === "low_stock" ? text("stockLow") : state === "out_of_stock" ? text("stockOut") : text("stockReady");
      }
      if (announcement !== null) {
        announcement.textContent = next.announcement;
        announcement.hidden = next.announcement.length === 0;
      }
      if (logo !== null) {
        logo.replaceChildren();
        if (next.logoUrl) {
          const image = document.createElement("img");
          image.src = next.logoUrl;
          image.alt = "";
          image.loading = "lazy";
          logo.appendChild(image);
        } else {
          logo.textContent = "S";
        }
      }
      return validation;
    };

    const hasChanges = (next: StorefrontDraft): boolean => JSON.stringify(next) !== JSON.stringify(saved);
    const updateControls = (next: StorefrontDraft, announceRecovery = false): StorefrontContrastValidation => {
      const validation = updatePreview(next);
      const changed = hasChanges(next);
      setState(validation.valid ? changed ? "unsaved" : publicationState : "invalid_contrast");
      if (saveButton !== null) saveButton.disabled = !canManage || !changed || !validation.valid;
      if (undoButton !== null) undoButton.disabled = !canManage || !changed;
      if (publishButton !== null) publishButton.disabled = !canPublish || changed || publicationState === "published" || !validation.valid;
      if (!validation.valid) setFeedback(contrastMessage(validation));
      else if (announceRecovery) setFeedback(text("contrastRecovered"));
      return validation;
    };

    const setMobileView = (view: "preview" | "settings"): void => {
      builder.dataset.mobileView = view;
      for (const tab of mobileViewTabs) {
        const active = tab.dataset.builderViewTab === view;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      }
    };
    const api = async (path: string, method: string, body: unknown): Promise<StorefrontSettingsResponse> => {
      const csrf = readCookie(csrfCookieName);
      const response = await fetch(path, {
        body: JSON.stringify(body),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        method,
      });
      const payload: unknown = await response.json();
      const code = typeof payload === "object" && payload !== null && "code" in payload
        && typeof payload.code === "string" ? payload.code : "request_failed";
      if (!response.ok) throw new Error(code);
      if (typeof payload !== "object" || payload === null || !("settings" in payload)) throw new Error("response_invalid");
      const settings = payload.settings;
      if (typeof settings !== "object" || settings === null
        || !("version" in settings) || typeof settings.version !== "number" || !Number.isSafeInteger(settings.version)
        || !("publicationState" in settings)
        || !new Set(["never_published", "published", "unpublished_changes"]).has(String(settings.publicationState))) {
        throw new Error("response_invalid");
      }
      return payload as StorefrontSettingsResponse;
    };

    let contrastWasValid = validateStorefrontContrast(saved.primaryColor, saved.accentColor).valid;
    builder.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const next = readDraft();
        const validation = updateControls(next, !contrastWasValid);
        contrastWasValid = validation.valid;
      });
    });

    undoButton?.addEventListener("click", () => {
      (Object.entries(saved) as Array<[keyof StorefrontDraft, string | boolean]>).forEach(([key, value]) => {
        if (key === "templateId") return;
        const input = field(key);
        if (input === null) return;
        if (typeof value === "boolean" && input instanceof HTMLInputElement) input.checked = value;
        else if (typeof value === "string") input.value = value;
      });
      setTemplateSelection(saved.templateId);
      const validation = updateControls(saved);
      contrastWasValid = validation.valid;
      setFeedback(validation.valid ? text("undone") : contrastMessage(validation));
    });

    saveButton?.addEventListener("click", () => {
      void (async () => {
      if (!canManage || !shopPublicId) return;
      const next = readDraft();
      if (!hasChanges(next)) return;
      const validation = updateContrast(next);
      if (!validation.valid) {
        setState("invalid_contrast");
        setFeedback(contrastMessage(validation));
        return;
      }
      saveButton.disabled = true;
      if (undoButton !== null) undoButton.disabled = true;
      setState("saving");
      setFeedback(text("savePending"));
      try {
        const response = await api(`/api/app/shops/${shopPublicId}/storefront/draft`, "PATCH", {
          ...next,
          announcement: next.announcement || null,
          expectedVersion: draftVersion,
          logoUrl: next.logoUrl || null,
          ...(next.sections === undefined || next.sections === null ? {} : { sections: next.sections }),
        });
        saved = next;
        draftVersion = response.settings.version;
        publicationState = response.settings.publicationState;
        builder.dataset.draftVersion = String(draftVersion);
        builder.dataset.publicationState = publicationState;
        setState(publicationState);
        updatePublicationBadge();
        setFeedback(text("saveSuccess"));
        updateControls(saved);
      } catch (error) {
        setState("failed");
        setFeedback(error instanceof Error && error.message === "resource_conflict"
          ? text("conflictReload")
          : error instanceof Error ? text("saveError", { error: error.message }) : text("saveFailed"));
        saveButton.disabled = false;
        if (undoButton !== null) undoButton.disabled = false;
      }
      })();
    });

    publishButton?.addEventListener("click", () => {
      void (async () => {
      if (!canManage || !shopPublicId) return;
      const next = readDraft();
      const validation = updateContrast(next);
      if (!validation.valid) {
        setState("invalid_contrast");
        setFeedback(contrastMessage(validation));
        return;
      }
      if (hasChanges(next)) {
        setFeedback(text("saveBeforePublish"));
        return;
      }
      publishButton.disabled = true;
      setState("publishing");
      setFeedback(text("publishPending"));
      try {
        const response = await api(`/api/app/shops/${shopPublicId}/storefront/publish`, "POST", { expectedVersion: draftVersion });
        draftVersion = response.settings.version;
        publicationState = response.settings.publicationState;
        builder.dataset.draftVersion = String(draftVersion);
        builder.dataset.publicationState = publicationState;
        setState(publicationState);
        updatePublicationBadge();
        setFeedback(text("publishSuccess"));
      } catch (error) {
        setState("failed");
        const errorCode = error instanceof Error ? error.message : "";
        if (errorCode === "readiness_failed") {
          // Surface each failed required readiness check instead of the raw 409.
          setFeedback(text("publishBlockers"));
          await renderPublishBlockers();
        } else {
          setFeedback(error instanceof Error && errorCode === "resource_conflict"
            ? text("publishConflict")
            : error instanceof Error ? text("publishError", { error: errorCode }) : text("publishFailed"));
        }
        publishButton.disabled = false;
      }
      })();
    });

    builder.querySelectorAll<HTMLElement>("[data-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      if (name === undefined) return;
      builder.querySelectorAll<HTMLElement>("[data-tab]").forEach((candidate) => {
        const active = candidate === tab;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-selected", String(active));
      });
      builder.querySelectorAll<HTMLElement>("[data-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.panel !== name;
      });
      });
    });

    mobileViewTabs.forEach((tab, index) => {
      tab.addEventListener("click", () => {
        setMobileView(tab.dataset.builderViewTab === "preview" ? "preview" : "settings");
      });
      tab.addEventListener("keydown", (event) => {
        if (!new Set(["ArrowLeft", "ArrowRight", "Home", "End"]).has(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0
          : event.key === "End" ? mobileViewTabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + mobileViewTabs.length) % mobileViewTabs.length;
        const next = mobileViewTabs[nextIndex];
        if (next === undefined) return;
        setMobileView(next.dataset.builderViewTab === "preview" ? "preview" : "settings");
        next.focus();
      });
    });

    builder.querySelectorAll<HTMLButtonElement>(".device-button[data-device]").forEach((button) => {
      button.addEventListener("click", () => {
      const device = button.dataset.device ?? "desktop";
      builder.querySelectorAll<HTMLButtonElement>(".device-button[data-device]").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      const frame = builder.querySelector<HTMLElement>("[data-preview-frame]");
      if (frame !== null) frame.dataset.device = device;
      });
    });

    // TM1: home layout panel — toggle/reorder universal sections, persist the
    // full config through the same draft save (hidden input carries the JSON).
    const sectionStack: HTMLElement | null = builder.querySelector("[data-section-stack]");
    const sectionNote = builder.querySelector<HTMLElement>("[data-section-note]");
    const sectionsField = builder.querySelector<HTMLInputElement>('[data-field="sections"]');

    type SectionRowState = { enabled: boolean; type: string };

    const readSectionRows = (): SectionRowState[] => [...(sectionStack?.querySelectorAll<HTMLElement>("[data-section-row]") ?? [])].map((row) => ({
      enabled: row.dataset.sectionDisabled !== "true",
      type: row.dataset.sectionRow ?? "",
    }));

    const readSectionItems = (sectionType: string): Array<Record<string, string>> => {
      const inputs = [...builder.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`[data-section-item="${sectionType}"]`)];
      const byIndex = new Map<number, Record<string, string>>();
      for (const input of inputs) {
        const index = Number.parseInt(input.dataset.sectionItemIndex ?? "0", 10);
        const field = input.dataset.sectionItemField ?? "";
        const value = input.value.trim();
        if (!Number.isSafeInteger(index) || field.length === 0) continue;
        const record = byIndex.get(index) ?? {};
        if (value.length > 0) record[field] = value;
        byIndex.set(index, record);
      }
      return [...byIndex.entries()]
        .filter(([, record]) => Object.keys(record).length > 0)
        .map(([index, record]) => ({ _index: index, ...record }))
        .sort((left, right) => left._index - right._index)
        .map(({ _index, ...record }) => {
          void _index;
          return record;
        });
    };

    const writeSectionsField = (): void => {
      if (sectionsField === null) return;
      const rows = readSectionRows();
      // Persist the FULL stack (native locked rows included) so the config is
      // self-describing; the server parser bounds and cleans it. Universal
      // sections carry their merchant-edited item lists in settings.
      const config = rows
        .filter((row) => row.enabled)
        .map((row) => {
          if (row.type !== "usp" && row.type !== "faq") return { enabled: true, id: `cfg-${row.type}`, settings: {}, type: row.type };
          const items = readSectionItems(row.type);
          return { enabled: true, id: `cfg-${row.type}`, settings: items.length > 0 ? { items } : {}, type: row.type };
        });
      sectionsField.value = JSON.stringify(config);
      if (sectionNote !== null) {
        const anyUniversalEnabled = rows.some((row) => (row.type === "usp" || row.type === "faq") && row.enabled);
        sectionNote.textContent = anyUniversalEnabled ? "" : text("console.builder.sections.empty_warning");
      }
      syncSectionPreview(rows);
      updateControls(readDraft());
    };

    const syncSectionPreview = (rows: SectionRowState[]): void => {
      const usp: HTMLElement | null = builder.querySelector("[data-preview-usp]");
      const faq: HTMLElement | null = builder.querySelector("[data-preview-faq]");
      const uspEnabled = rows.some((row) => row.type === "usp" && row.enabled);
      const faqEnabled = rows.some((row) => row.type === "faq" && row.enabled);
      if (usp !== null) usp.hidden = !uspEnabled;
      if (faq !== null) faq.hidden = !faqEnabled;
    };

    const refreshSectionRowChrome = (): void => {
      const rows = [...(sectionStack?.querySelectorAll<HTMLElement>("[data-section-row]") ?? [])];
      const editableRows = rows.filter((row) => row.dataset.sectionRow === "usp" || row.dataset.sectionRow === "faq");
      for (const [index, row] of editableRows.entries()) {
        const up = row.querySelector<HTMLButtonElement>('[data-section-move="up"]');
        const down = row.querySelector<HTMLButtonElement>('[data-section-move="down"]');
        if (up !== null) up.disabled = index === 0;
        if (down !== null) down.disabled = index === editableRows.length - 1;
      }
    };

    sectionStack?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const move = target.closest<HTMLButtonElement>("[data-section-move]");
      if (move !== null) {
        const direction = move.dataset.sectionMove === "up" ? -1 : 1;
        const row = move.closest<HTMLElement>("[data-section-row]");
        if (row !== null) {
          const editable = [...sectionStack.querySelectorAll<HTMLElement>("[data-section-row]")].filter((candidate) => candidate.dataset.sectionRow === "usp" || candidate.dataset.sectionRow === "faq");
          const index = editable.indexOf(row);
          const swapWith: HTMLElement | undefined = editable[index + direction];
          if (index >= 0 && swapWith !== undefined) {
            const anchor: Node | null = direction === -1 ? swapWith : swapWith.nextSibling;
            sectionStack.insertBefore(row, anchor);
            refreshSectionRowChrome();
            writeSectionsField();
          }
        }
        return;
      }
      const restore = target.closest<HTMLButtonElement>("[data-section-restore]");
      if (restore !== null) {
        try {
          const defaults = JSON.parse(sectionStack.dataset.defaultStack ?? "[]") as Array<{ type: string }>;
          sectionStack.replaceChildren(...defaults.map((entry) => buildSectionRow(entry.type)));
        } catch {
          // Default stack markup is server-rendered; a parse failure here means
          // the dataset was tampered with — rebuilding from locked rows is fine.
        }
        refreshSectionRowChrome();
        writeSectionsField();
        if (sectionNote !== null) sectionNote.textContent = text("console.builder.sections.restored");
        return;
      }
    });

    const itemsEditor = builder.querySelector<HTMLElement>("[data-section-items-editor]");
    itemsEditor?.addEventListener("input", () => {
      writeSectionsField();
    });

    sectionStack?.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.hasAttribute("data-section-toggle")) return;
      const row = target.closest<HTMLElement>("[data-section-row]");
      if (row !== null) row.dataset.sectionDisabled = target.checked ? "true" : "false";
      row?.classList.toggle("is-off", !target.checked);
      writeSectionsField();
    });

    const buildSectionRow = (type: string): HTMLElement => {
      // Reuse the server-rendered locked row as the clone source so restored
      // rows keep exact markup and styles.
      const source = sectionStack === null ? null : sectionStack.querySelector<HTMLElement>(`[data-section-row="${CSS.escape(type)}"]`);
      if (source !== null) return source.cloneNode(true) as HTMLElement;
      const fallback = document.createElement("li");
      fallback.dataset.sectionRow = type;
      return fallback;
    };

    refreshSectionRowChrome();
    syncSectionPreview(readSectionRows());

    // Shipping methods management (physical vertical, TV5).
    const shippingList = builder.querySelector<HTMLElement>("[data-shipping-list]");
    const shippingFeedback = builder.querySelector<HTMLElement>("[data-shipping-feedback]");
    const shippingCreateButton = builder.querySelector<HTMLButtonElement>("[data-shipping-create]");
    const shippingNameInput = builder.querySelector<HTMLInputElement>("[data-shipping-name]");
    const shippingFeeInput = builder.querySelector<HTMLInputElement>("[data-shipping-fee]");
    const shippingFreeOverInput = builder.querySelector<HTMLInputElement>("[data-shipping-free-over]");
    type ShippingMethodRow = { feeMinor: number; freeOverMinor: number | null; id: string; name: string; status: string };
    const shippingCsrf = (): string | null => readCookie(csrfCookieName);
    const renderShippingMethods = (rows: ShippingMethodRow[]): void => {
      if (shippingList === null) return;
      shippingList.replaceChildren();
      const active = rows.filter((method) => method.status === "active");
      for (const row of active) {
        const item = document.createElement("li");
        const copy = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = row.name;
        const detail = document.createElement("small");
        const feeLabel = text("shippingFeeLabel") + ": " + row.feeMinor.toLocaleString("vi-VN");
        detail.textContent = row.freeOverMinor === null
          ? feeLabel
          : feeLabel + " · " + text("shippingFreeOverLabel") + ": " + row.freeOverMinor.toLocaleString("vi-VN");
        copy.appendChild(name);
        copy.appendChild(detail);
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = "sln-button";
        archive.dataset.variant = "danger";
        archive.textContent = text("shippingArchive");
        archive.addEventListener("click", () => { void archiveShippingMethod(row.id); });
        item.appendChild(copy);
        item.appendChild(archive);
        shippingList.appendChild(item);
      }
      if (active.length === 0) {
        const empty = document.createElement("li");
        const emptyText = document.createElement("small");
        emptyText.textContent = text("shippingEmpty");
        empty.appendChild(emptyText);
        shippingList.appendChild(empty);
      }
    };
    const loadShippingMethods = async (): Promise<void> => {
      try {
        const response = await fetch("/api/app/shops/" + shopPublicId + "/shipping-methods", { credentials: "same-origin" });
        if (!response.ok) return;
        const payload = await response.json();
        if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { methods?: unknown }).methods)) return;
        renderShippingMethods((payload as { methods: ShippingMethodRow[] }).methods);
      } catch {
        // Best-effort panel; the API remains the source of truth.
      }
    };
    const createShippingMethod = async (): Promise<void> => {
      if (shippingCreateButton === null || shippingNameInput === null || shippingFeeInput === null) return;
      const name = shippingNameInput.value.trim();
      const feeMinor = Number(shippingFeeInput.value);
      const freeOverRaw = shippingFreeOverInput === null ? "" : shippingFreeOverInput.value.trim();
      if (name === "" || !Number.isSafeInteger(feeMinor) || feeMinor < 0) {
        if (shippingFeedback !== null) shippingFeedback.textContent = text("shippingInvalid");
        return;
      }
      shippingCreateButton.disabled = true;
      try {
        const csrf = shippingCsrf();
        const response = await fetch("/api/app/shops/" + shopPublicId + "/shipping-methods", {
          body: JSON.stringify({ feeMinor, freeOverMinor: freeOverRaw === "" ? null : Number(freeOverRaw), name }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...(csrf === null ? {} : { "X-CSRF-Token": decodeURIComponent(csrf) }) },
          method: "POST",
        });
        if (!response.ok) throw new Error("shipping_create_failed");
        shippingNameInput.value = "";
        shippingFeeInput.value = "";
        if (shippingFreeOverInput !== null) shippingFreeOverInput.value = "";
        if (shippingFeedback !== null) shippingFeedback.textContent = text("shippingCreated");
        await loadShippingMethods();
      } catch {
        if (shippingFeedback !== null) shippingFeedback.textContent = text("shippingError");
      } finally {
        shippingCreateButton.disabled = false;
      }
    };
    const archiveShippingMethod = async (methodId: string): Promise<void> => {
      try {
        const csrf = shippingCsrf();
        const response = await fetch("/api/app/shops/" + shopPublicId + "/shipping-methods/" + methodId, {
          body: JSON.stringify({ status: "archived" }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...(csrf === null ? {} : { "X-CSRF-Token": decodeURIComponent(csrf) }) },
          method: "PATCH",
        });
        if (!response.ok) throw new Error("shipping_archive_failed");
        await loadShippingMethods();
      } catch {
        if (shippingFeedback !== null) shippingFeedback.textContent = text("shippingError");
      }
    };
    shippingCreateButton?.addEventListener("click", () => { void createShippingMethod(); });
    void loadShippingMethods();
    updatePublicationBadge();
    setMobileView("settings");
    const initialValidation = updateControls(saved);
    contrastWasValid = initialValidation.valid;
  }
}
