type WizardStep = "celebration" | "connect" | "inventory" | "product" | "store";

type ShopResponse = {
  shop?: {
    publicId?: string;
    slug?: string;
  };
};

type SeedResponse = {
  importedKeysCount?: number;
  variant?: {
    id?: string;
  };
};

type ProductCreateResponse = {
  variant?: {
    id?: string;
  };
};

type InventoryPreviewResponse = {
  previewToken?: string;
};

type InventoryImportResponse = {
  acceptedCount?: number;
};

type TelegramResponse = {
  bot?: {
    username?: string;
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

function initQuickstart(): void {
  const root = document.querySelector<HTMLElement>("[data-quickstart-root]");
  if (!root) return;

  const csrfCookieName = root.dataset.csrfCookieName || "selinow_session_csrf";
  const platformBaseDomain = root.dataset.platformBaseDomain || "selinow.com";
  const defaultCurrency = root.dataset.defaultCurrency || "VND";
  const toastEl = root.querySelector<HTMLElement>("[data-onboarding-toast]");

  let activeShopPublicId = root.dataset.activeShopPublicId || "";
  let activeShopSlug = "";
  let createdVariantId = "";
  let selectedPresetId = "win11pro";
  let currentProductMode: "custom" | "preset" = "preset";

  function showToast(message: string, tone: "error" | "success" = "success"): void {
    if (!toastEl) return;
    toastEl.dataset.tone = tone;
    toastEl.textContent = message;
    toastEl.hidden = false;
    setTimeout(() => {
      toastEl.hidden = true;
    }, 4000);
  }

  function setStep(step: WizardStep): void {
    if (!root) return;
    const panes = root.querySelectorAll<HTMLElement>("[data-step-pane]");
    panes.forEach((pane) => {
      pane.hidden = pane.dataset.stepPane !== step;
    });

    const indicators = root.querySelectorAll<HTMLElement>("[data-step-indicator]");
    const stepOrder: WizardStep[] = ["store", "product", "inventory", "connect", "celebration"];
    const currentIndex = stepOrder.indexOf(step);

    indicators.forEach((ind) => {
      const indStep = ind.dataset.stepIndicator as WizardStep;
      const indIndex = stepOrder.indexOf(indStep);
      ind.classList.remove("active", "done");
      if (indIndex === currentIndex) {
        ind.classList.add("active");
      } else if (indIndex < currentIndex) {
        ind.classList.add("done");
      }
    });

    window.scrollTo({ behavior: "smooth", top: 0 });

    if (step === "celebration") {
      triggerConfetti();
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

  // --- Live Preview Elements ---
  const previewSlugEls = root.querySelectorAll<HTMLElement>("[data-preview-slug]");
  const previewShopNameEls = root.querySelectorAll<HTMLElement>("[data-preview-shop-name]");
  const previewProductTitleEls = root.querySelectorAll<HTMLElement>("[data-preview-product-title]");
  const previewProductTitleShortEls = root.querySelectorAll<HTMLElement>("[data-preview-product-title-short]");
  const previewProductPriceEls = root.querySelectorAll<HTMLElement>("[data-preview-product-price]");
  const previewProductDescEls = root.querySelectorAll<HTMLElement>("[data-preview-product-desc]");
  const previewProductIconEls = root.querySelectorAll<HTMLElement>("[data-preview-product-icon]");
  const previewFulfillmentEls = root.querySelectorAll<HTMLElement>("[data-preview-fulfillment]");

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

  // --- Step 1: Store & Channels ---
  const storeForm = root.querySelector<HTMLFormElement>("[data-store-form]");
  const nameInput = root.querySelector<HTMLInputElement>("[data-input-shop-name]");
  const slugInput = root.querySelector<HTMLInputElement>("[data-input-shop-slug]");
  const channelRadios = root.querySelectorAll<HTMLInputElement>("[data-channel-radio]");
  const channelCards = root.querySelectorAll<HTMLElement>("[data-channel-opt]");

  nameInput?.addEventListener("input", () => {
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
      });
      const tgSection = root.querySelector<HTMLElement>("[data-telegram-connect-section]");
      if (tgSection) {
        tgSection.hidden = radio.value === "website";
      }
    });
  });

  storeForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const name = nameInput?.value.trim() || "";
      const slug = slugInput?.value.trim() || slugify(name);

      if (!name || !slug) {
        showToast("Vui lòng nhập tên cửa hàng hợp lệ.", "error");
        return;
      }

      const submitBtn = storeForm.querySelector<HTMLButtonElement>("[data-step-submit='store']");
      if (submitBtn) submitBtn.disabled = true;

      try {
        let shopPubId = activeShopPublicId;

        if (!shopPubId) {
          const res = await apiRequest("/api/app/shops", {
            body: JSON.stringify({
              currency: defaultCurrency,
              defaultLocale: "vi-VN",
              name,
              planCode: "starter",
              slug,
            }),
            headers: {
              "Idempotency-Key": `shop-create-${slug}-${String(Date.now())}`,
            },
            method: "POST",
          });

          if (!res.ok) {
            showToast("Không thể tạo cửa hàng. Vui lòng kiểm tra lại slug hoặc kết nối mạng.", "error");
            if (submitBtn) submitBtn.disabled = false;
            return;
          }

          const shopData = res.data as ShopResponse;
          shopPubId = shopData.shop?.publicId ?? "";
          activeShopPublicId = shopPubId;
        }

        activeShopSlug = slug;

        // Configure Channels
        const selectedChannel = Array.from(channelRadios).find((r) => r.checked)?.value || "both";
        await apiRequest(`/api/app/shops/${encodeURIComponent(shopPubId)}/onboarding/channels`, {
          body: JSON.stringify({
            customDomainPreference: "later",
            telegramEnabled: selectedChannel !== "website",
            websiteEnabled: selectedChannel !== "telegram",
          }),
          method: "POST",
        });

        showToast("Đã lưu thông tin cửa hàng thành công!");
        setStep("product");
      } catch {
        showToast("Có lỗi xảy ra khi lưu thông tin cửa hàng.", "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    })();
  });

  // --- Step 2: Products & Presets ---
  const modeTabs = root.querySelectorAll<HTMLButtonElement>("[data-product-mode]");
  const presetsContainer = root.querySelector<HTMLElement>("[data-presets-container]");
  const customProductForm = root.querySelector<HTMLFormElement>("[data-product-form]");
  const presetCards = root.querySelectorAll<HTMLButtonElement>("[data-preset-card]");

  const customTitleInput = root.querySelector<HTMLInputElement>("[data-input-product-title]");
  const customPriceInput = root.querySelector<HTMLInputElement>("[data-input-product-price]");
  const customFulfillmentSelect = root.querySelector("[data-input-product-fulfillment]") as HTMLSelectElement | null;
  const customDescTextarea = root.querySelector<HTMLTextAreaElement>("[data-input-product-desc]");

  modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      modeTabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      currentProductMode = tab.dataset.productMode === "custom" ? "custom" : "preset";
      if (presetsContainer && customProductForm) {
        presetsContainer.hidden = currentProductMode !== "preset";
        customProductForm.hidden = currentProductMode !== "custom";
      }
    });
  });

  presetCards.forEach((card) => {
    card.addEventListener("click", () => {
      presetCards.forEach((c) => {
        c.classList.remove("selected");
      });
      card.classList.add("selected");
      selectedPresetId = card.dataset.presetCard || "win11pro";

      const title = card.dataset.presetTitle || "";
      const price = Number(card.dataset.presetPrice || 0);
      const icon = card.dataset.presetIcon || "⚡";
      const desc = card.dataset.presetDesc || "";
      const fulfillment = card.dataset.presetFulfillment === "manual" ? "Giao thủ công" : "Tự động giao key";

      previewProductTitleEls.forEach((el) => { el.textContent = title; });
      previewProductTitleShortEls.forEach((el) => { el.textContent = title.split(" ")[0] || title; });
      previewProductPriceEls.forEach((el) => { el.textContent = `${price.toLocaleString("vi-VN")} ${defaultCurrency}`; });
      previewProductIconEls.forEach((el) => { el.textContent = icon; });
      previewProductDescEls.forEach((el) => { el.textContent = desc; });
      previewFulfillmentEls.forEach((el) => { el.textContent = fulfillment; });
    });
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
          const res = await apiRequest(
            `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/onboarding/seed-preset`,
            {
              body: JSON.stringify({ presetId: selectedPresetId }),
              method: "POST",
            },
          );

          if (!res.ok) {
            showToast("Không thể tạo sản phẩm mẫu. Vui lòng thử lại.", "error");
            productSubmitBtn.disabled = false;
            return;
          }

          const seedData = res.data as SeedResponse;
          createdVariantId = seedData.variant?.id ?? "";
          const importedCount = seedData.importedKeysCount ?? 0;
          showToast(`Đã tạo sản phẩm và nạp ${String(importedCount)} key mẫu vào kho!`);
        } else {
          const title = customTitleInput?.value.trim() || "Sản phẩm mới";
          const price = Number(customPriceInput?.value || 0);
          const fulfillmentType = customFulfillmentSelect?.value || "license_key";
          const description = customDescTextarea?.value.trim() || "";

          const res = await apiRequest(
            `/api/app/shops/${encodeURIComponent(activeShopPublicId)}/catalog/products`,
            {
              body: JSON.stringify({
                data: {
                  categoryId: null,
                  description,
                  fulfillmentType,
                  slug: `${slugify(title)}-${String(Date.now()).slice(-4)}`,
                  status: "active",
                  title,
                },
                initialVariant: {
                  currency: defaultCurrency,
                  maxPerOrder: 10,
                  minPerOrder: 1,
                  priceMinor: price,
                  sku: `SKU-${String(Date.now()).slice(-6)}`,
                  status: "active",
                  title: "Mặc định",
                },
              }),
              headers: {
                "Idempotency-Key": `custom-prod-${String(Date.now())}`,
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
          showToast("Đã tạo sản phẩm thành công!");
        }

        setStep("inventory");
      } catch {
        showToast("Có lỗi xảy ra khi tạo sản phẩm.", "error");
      } finally {
        productSubmitBtn.disabled = false;
      }
    })();
  });

  // --- Step 3: Inventory Keys ---
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

    if (countBadge) countBadge.textContent = `${String(valid)} key`;
    if (totalMetric) totalMetric.textContent = String(total);
    if (validMetric) validMetric.textContent = String(valid);
    if (dupMetric) dupMetric.textContent = String(dups);
  }

  keysTextarea?.addEventListener("input", updateKeyMetrics);

  genSampleKeysBtn?.addEventListener("click", () => {
    const samples = [
      `WIN11-PRO-${Math.random().toString(36).slice(2, 7).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      `WIN11-PRO-${Math.random().toString(36).slice(2, 7).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      `WIN11-PRO-${Math.random().toString(36).slice(2, 7).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      `WIN11-PRO-${Math.random().toString(36).slice(2, 7).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      `WIN11-PRO-${Math.random().toString(36).slice(2, 7).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    ];
    if (keysTextarea) {
      keysTextarea.value = samples.join("\n");
      updateKeyMetrics();
      showToast("Đã tạo 5 key thử nghiệm!");
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
              "Idempotency-Key": `import-keys-${String(Date.now())}`,
            },
            method: "POST",
          },
        );

        if (importRes.ok) {
          const importData = importRes.data as InventoryImportResponse;
          const accepted = importData.acceptedCount ?? 0;
          showToast(`Đã mã hóa và nạp ${String(accepted)} key vào kho an toàn!`);
          setStep("connect");
        } else {
          showToast("Có lỗi xảy ra khi nạp key vào kho.", "error");
        }
      } catch {
        showToast("Có lỗi xảy ra khi nạp key.", "error");
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
        const res = await apiRequest(`/api/app/shops/${encodeURIComponent(activeShopPublicId)}/integrations/payos`, {
          body: JSON.stringify({ apiKey, checksumKey, clientId }),
          method: "POST",
        });

        if (res.ok) {
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
            method: "POST",
          },
        );

        const tgData = res.data as TelegramResponse;
        const botUser = tgData.bot?.username ?? "";

        if (res.ok && botUser) {
          if (tgStatusPill) {
            tgStatusPill.dataset.status = "verified";
            tgStatusPill.textContent = `✓ Đã kết nối @${botUser}`;
          }
          const tgLinkEl = root.querySelector<HTMLAnchorElement>("[data-celebration-telegram-link]");
          const tgDisplay = root.querySelector<HTMLElement>("[data-celebration-bot-display]");
          if (tgLinkEl && tgDisplay) {
            tgLinkEl.href = `https://t.me/${botUser}`;
            tgLinkEl.hidden = false;
            tgDisplay.textContent = `@${botUser}`;
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

  function completeAndCelebrate(): void {
    if (!root) return;
    const storefrontLink = root.querySelector<HTMLAnchorElement>("[data-celebration-storefront-link]");
    const slugDisplay = root.querySelector<HTMLElement>("[data-celebration-slug-display]");
    const dashboardLink = root.querySelector<HTMLAnchorElement>("[data-celebration-dashboard-link]");

    const finalSlug = activeShopSlug || "cua-hang";
    if (storefrontLink && slugDisplay) {
      storefrontLink.href = `https://${finalSlug}.${platformBaseDomain}`;
      slugDisplay.textContent = `https://${finalSlug}.${platformBaseDomain}`;
    }
    if (dashboardLink && activeShopPublicId) {
      dashboardLink.href = `/app?shop=${encodeURIComponent(activeShopPublicId)}`;
    }

    setStep("celebration");
  }

  skipConnectBtn?.addEventListener("click", completeAndCelebrate);

  launchBtn?.addEventListener("click", () => {
    void (async () => {
      launchBtn.disabled = true;
      try {
        if (activeShopPublicId) {
          await apiRequest(`/api/app/shops/${encodeURIComponent(activeShopPublicId)}/publish`, {
            method: "POST",
          });
        }
      } catch {
        // Continue even if publish warning
      } finally {
        launchBtn.disabled = false;
        completeAndCelebrate();
      }
    })();
  });

  // --- Back Navigation Buttons ---
  root.querySelectorAll<HTMLButtonElement>("[data-step-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.stepBack as WizardStep;
      setStep(target);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initQuickstart);
} else {
  initQuickstart();
}
