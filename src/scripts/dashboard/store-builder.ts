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
  showExactStock: boolean;
  supportText: string;
};

type StorefrontSettingsResponse = {
  settings: {
    publicationState: "never_published" | "published" | "unpublished_changes";
    version: number;
  };
};

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
        || typeof draft.supportText !== "string") return null;
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
        showExactStock: draft.showExactStock,
        supportText: draft.supportText,
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

    const readDraft = (): StorefrontDraft => {
      const stockField = field("showExactStock");
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
        showExactStock: stockField instanceof HTMLInputElement ? stockField.checked : saved.showExactStock,
        supportText: field("supportText")?.value.trim() ?? "",
      };
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
        const input = field(key);
        if (input === null) return;
        if (typeof value === "boolean" && input instanceof HTMLInputElement) input.checked = value;
        else if (typeof value === "string") input.value = value;
      });
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
        setFeedback(error instanceof Error && error.message === "resource_conflict"
          ? text("publishConflict")
          : error instanceof Error ? text("publishError", { error: error.message }) : text("publishFailed"));
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

    updatePublicationBadge();
    setMobileView("settings");
    const initialValidation = updateControls(saved);
    contrastWasValid = initialValidation.valid;
  }
}
