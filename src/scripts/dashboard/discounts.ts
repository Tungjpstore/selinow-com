import { createDashboardTranslator } from "../../lib/i18n/catalogs/dashboard";
import { normalizeCurrencyCode, parseMajorAmountToMinor } from "../../lib/i18n/currency";

type JsonObject = Record<string, unknown>;

type DiscountView = {
  code: string;
  createdAt: string;
  currency: string | null;
  endsAt: string | null;
  id: string;
  minimumMinor: number;
  startsAt: string | null;
  status: string;
  type: string;
  updatedAt: string;
  value: number;
};

const t = createDashboardTranslator(document.documentElement.lang || "en");

const workspace = document.querySelector<HTMLElement>("[data-discounts-workspace]");
if (workspace !== null) {
  const shopPublicId = workspace.dataset.shopPublicId;
  const csrfCookieName = workspace.dataset.csrfCookieName;
  const defaultCurrency = normalizeCurrencyCode(workspace.dataset.defaultCurrency);
  const timeZone = workspace.dataset.timeZone ?? "Asia/Ho_Chi_Minh";
  const rows = workspace.querySelector<HTMLElement>("[data-discount-rows]");
  const empty = workspace.querySelector<HTMLElement>("[data-discounts-empty]");
  const feedback = workspace.querySelector<HTMLElement>("[data-discounts-feedback]");
  const dialog = document.querySelector<HTMLDialogElement>("[data-discount-dialog]");
  const openButton = workspace.querySelector<HTMLButtonElement>("[data-open-discount-form]");
  const form = document.querySelector<HTMLFormElement>("[data-discount-form]");
  const closeButton = document.querySelector<HTMLButtonElement>("[data-close-discount-form]");

  const readCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const setFeedback = (message: string, tone: "danger" | "info" | "success"): void => {
    if (feedback === null) return;
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = message.length === 0;
    feedback.setAttribute("role", tone === "danger" ? "alert" : "status");
  };

  const request = async (path: string, method: string, body: JsonObject | null): Promise<JsonObject> => {
    if (csrfCookieName === undefined) throw new Error("csrf_missing");
    const csrf = readCookie(csrfCookieName);
    if (csrf === null) throw new Error("csrf_missing");
    const init: RequestInit = {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": decodeURIComponent(csrf),
      },
      method,
    };
    if (body !== null) init.body = JSON.stringify(body);
    const response = await fetch(path, init);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope: JsonObject = typeof payload === "object" && payload !== null ? payload as JsonObject : {};
      const rawDetails: unknown = envelope.details;
      const details = Array.isArray(rawDetails) ? rawDetails.filter((item): item is string => typeof item === "string") : [];
      const code = typeof envelope.code === "string" ? envelope.code : "request_failed";
      throw new Error(details.length > 0 ? details[0] : code);
    }
    return typeof payload === "object" && payload !== null ? payload as JsonObject : {};
  };

  const money = (minor: number, currency: string | null): string => {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || "en", { style: "currency", currency: currency ?? "VND", maximumFractionDigits: 0 }).format(minor / 100);
    } catch {
      return String(minor);
    }
  };

  const dateLabel = (iso: string | null): string => {
    if (iso === null) return "—";
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return iso;
    try {
      return new Intl.DateTimeFormat(document.documentElement.lang || "en", { dateStyle: "medium", timeZone }).format(new Date(timestamp));
    } catch {
      return iso;
    }
  };

  const statusLabel = (status: string): string => {
    if (status === "active") return t("dashboard.discounts.status.active");
    if (status === "disabled") return t("dashboard.discounts.status.disabled");
    return t("dashboard.discounts.status.expired");
  };

  const statusBadge = (status: string): HTMLElement => {
    const badge = document.createElement("span");
    badge.className = "sln-status";
    badge.dataset.tone = status === "active" ? "success" : status === "expired" ? "neutral" : "warning";
    const dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(statusLabel(status)));
    return badge;
  };

  const valueLabel = (discount: DiscountView): string => discount.type === "percentage"
    ? t("dashboard.discounts.value_percentage", { value: String(discount.value) })
    : money(discount.value, discount.currency);

  const actionButton = (discount: DiscountView): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-action";
    button.dataset.discountAction = discount.status === "active" ? "disable" : "enable";
    button.dataset.discountId = discount.id;
    button.textContent = discount.status === "active" ? t("dashboard.discounts.action.disable") : t("dashboard.discounts.action.enable");
    return button;
  };

  const discountsFrom = (payload: JsonObject): DiscountView[] => {
    const values = payload.discounts;
    if (!Array.isArray(values)) return [];
    return values.filter((item): item is DiscountView => typeof item === "object" && item !== null
      && typeof (item as DiscountView).id === "string"
      && typeof (item as DiscountView).code === "string"
      && typeof (item as DiscountView).status === "string"
      && typeof (item as DiscountView).type === "string"
      && typeof (item as DiscountView).value === "number");
  };

  const renderRows = (discounts: readonly DiscountView[]): void => {
    if (rows === null) return;
    rows.replaceChildren();
    if (empty !== null) empty.hidden = discounts.length > 0;
    for (const discount of discounts) {
      const tr = document.createElement("tr");
      for (const text of [discount.code, valueLabel(discount), discount.minimumMinor > 0 ? money(discount.minimumMinor, discount.currency) : "—", `${dateLabel(discount.startsAt)} → ${dateLabel(discount.endsAt)}`]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      const statusCell = document.createElement("td");
      statusCell.appendChild(statusBadge(discount.status));
      tr.appendChild(statusCell);
      const actions = document.createElement("td");
      actions.appendChild(actionButton(discount));
      tr.appendChild(actions);
      rows.appendChild(tr);
    }
  };

  const load = async (): Promise<void> => {
    if (shopPublicId === undefined) return;
    try {
      const payload = await request(`/api/app/shops/${encodeURIComponent(shopPublicId)}/discounts`, "GET", null);
      renderRows(discountsFrom(payload));
      setFeedback("", "info");
    } catch (error) {
      setFeedback(t("dashboard.discounts.client.load_error", { code: error instanceof Error ? error.message : "request_failed" }), "danger");
    }
  };

  const toggleStatus = async (button: HTMLButtonElement): Promise<void> => {
    if (shopPublicId === undefined) return;
    const discountId = button.dataset.discountId;
    const nextStatus = button.dataset.discountAction === "enable" ? "active" : "disabled";
    if (discountId === undefined) return;
    button.disabled = true;
    setFeedback(t("dashboard.discounts.client.toggle_pending"), "info");
    try {
      await request(`/api/app/shops/${encodeURIComponent(shopPublicId)}/discounts/${encodeURIComponent(discountId)}`, "PATCH", { status: nextStatus });
      await load();
      setFeedback(t("dashboard.discounts.client.toggle_saved"), "success");
    } catch (error) {
      setFeedback(t("dashboard.discounts.client.toggle_error", { code: error instanceof Error ? error.message : "request_failed" }), "danger");
    } finally {
      button.disabled = false;
    }
  };

  const create = async (): Promise<void> => {
    if (form === null || shopPublicId === undefined || defaultCurrency === null) return;
    if (!form.reportValidity()) return;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const data = new FormData(form);
    const formString = (key: string): string => {
      const value = data.get(key);
      return typeof value === "string" ? value : "";
    };
    const code = formString("code").trim().toUpperCase();
    const type = data.get("type") === "percentage" ? "percentage" : "fixed";
    const rawValue = formString("valueMajor");
    const rawMinimum = formString("minimumMajor");
    const rawEndsAt = formString("endsAt");
    const value = type === "percentage" ? Number.parseInt(rawValue, 10) : parseMajorAmountToMinor(rawValue, defaultCurrency);
    if (value === null || !Number.isSafeInteger(value) || value <= 0) {
      setFeedback(t("dashboard.discounts.client.validation.discount_value_invalid"), "danger");
      return;
    }
    const minimumMajor = rawMinimum === "" ? 0 : parseMajorAmountToMinor(rawMinimum, defaultCurrency);
    if (minimumMajor === null || !Number.isSafeInteger(minimumMajor) || minimumMajor < 0) {
      setFeedback(t("dashboard.discounts.client.validation.discount_minimum_invalid"), "danger");
      return;
    }
    if (submit !== null) submit.disabled = true;
    setFeedback(t("dashboard.discounts.client.create_pending"), "info");
    try {
      await request(`/api/app/shops/${encodeURIComponent(shopPublicId)}/discounts`, "POST", {
        code,
        endsAt: rawEndsAt === "" ? null : new Date(rawEndsAt).toISOString(),
        minimumMinor: minimumMajor,
        type,
        value,
      });
      form.reset();
      dialog?.close();
      await load();
      setFeedback(t("dashboard.discounts.client.create_saved"), "success");
    } catch (error) {
      const code = error instanceof Error ? error.message : "request_failed";
      if (code === "discount_code_invalid") setFeedback(t("dashboard.discounts.client.validation.discount_code_invalid"), "danger");
      else if (code === "discount_type_invalid") setFeedback(t("dashboard.discounts.client.validation.discount_type_invalid"), "danger");
      else if (code === "discount_value_invalid") setFeedback(t("dashboard.discounts.client.validation.discount_value_invalid"), "danger");
      else if (code === "discount_minimum_invalid") setFeedback(t("dashboard.discounts.client.validation.discount_minimum_invalid"), "danger");
      else if (code === "discount_window_invalid") setFeedback(t("dashboard.discounts.client.validation.discount_window_invalid"), "danger");
      else setFeedback(t("dashboard.discounts.client.create_error", { code }), "danger");
    } finally {
      if (submit !== null) submit.disabled = false;
    }
  };

  openButton?.addEventListener("click", () => { dialog?.showModal(); });
  closeButton?.addEventListener("click", () => { dialog?.close(); });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void create();
  });
  rows?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.discountAction === undefined) return;
    void toggleStatus(target);
  });

  void load();
}
