export {};

type JsonObject = Record<string, unknown>;

type BookingRow = {
  bookingId: string;
  bookingStatus: string;
  endAt: string;
  orderPublicId: string;
  resourceName: string;
  startAt: string;
  variantTitle: string;
};

const panel = document.querySelector<HTMLElement>("[data-bookings]");

if (panel !== null) {
  const shopPublicId = panel.dataset.shopPublicId ?? "";
  const csrfCookieName = panel.dataset.csrfCookieName ?? "";
  const locale = panel.dataset.locale || "en";
  const copy = (() => {
    try {
      const parsed: unknown = JSON.parse(panel.dataset.copy ?? "{}");
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  })();
  const text = (key: string): string => copy[key] ?? "";
  const statusElement = panel.querySelector<HTMLElement>("[data-bookings-status]");
  const listElement = panel.querySelector<HTMLElement>("[data-bookings-list]");

  const readCookie = (name: string): string | null =>
    document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

  const formatSlot = (startAt: string, endAt: string): string => {
    const start = new Date(startAt);
    const end = new Date(endAt);
    return `${start.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })} · ${start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}–${end.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
  };

  const setBusy = (busy: boolean): void => {
    listElement?.querySelectorAll<HTMLButtonElement>("[data-booking-action]").forEach((button) => {
      button.disabled = busy;
    });
  };

  const transitionBooking = async (bookingId: string, nextStatus: string): Promise<void> => {
    setBusy(true);
    if (statusElement !== null) statusElement.textContent = text("loading");
    try {
      const csrf = readCookie(csrfCookieName);
      const response = await fetch(`/api/app/shops/${shopPublicId}/bookings/${bookingId}`, {
        body: JSON.stringify({ nextStatus }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(csrf === null ? {} : { "X-CSRF-Token": decodeURIComponent(csrf) }) },
        method: "POST",
      });
      if (!response.ok) throw new Error("booking_transition_failed");
      await loadBookings();
    } catch {
      if (statusElement !== null) statusElement.textContent = text("error");
    } finally {
      setBusy(false);
    }
  };

  const renderBookings = (rows: BookingRow[]): void => {
    if (listElement === null) return;
    listElement.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement("li");
      const emptyText = document.createElement("small");
      emptyText.textContent = text("empty");
      empty.appendChild(emptyText);
      listElement.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const item = document.createElement("li");
      const copyBlock = document.createElement("div");
      copyBlock.className = "booking-copy";
      const title = document.createElement("strong");
      title.textContent = `${row.variantTitle} · ${row.resourceName}`;
      const detail = document.createElement("small");
      detail.textContent = `${formatSlot(row.startAt, row.endAt)} · ${row.orderPublicId}`;
      copyBlock.appendChild(title);
      copyBlock.appendChild(detail);
      const actions = document.createElement("div");
      actions.className = "booking-actions";
      for (const [label, nextStatus, variant] of [
        [text("complete"), "completed", "secondary"],
        [text("noShow"), "no_show", "secondary"],
        [text("cancel"), "cancelled", "danger"],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sln-button";
        button.dataset.variant = variant;
        button.dataset.bookingAction = "";
        button.textContent = label;
        button.addEventListener("click", () => { void transitionBooking(row.bookingId, nextStatus); });
        actions.appendChild(button);
      }
      item.appendChild(copyBlock);
      item.appendChild(actions);
      listElement.appendChild(item);
    }
  };

  const loadBookings = async (): Promise<void> => {
    if (statusElement !== null) statusElement.textContent = text("loading");
    try {
      const rangeStart = new Date().toISOString();
      const rangeEnd = new Date(Date.now() + 14 * 86_400_000).toISOString();
      const params = new URLSearchParams({ rangeEnd, rangeStart });
      const response = await fetch(`/api/app/shops/${shopPublicId}/bookings?${params.toString()}`, { credentials: "same-origin" });
      const payload = await response.json();
      if (!response.ok || typeof payload !== "object" || payload === null || !Array.isArray((payload as JsonObject).bookings)) {
        throw new Error("booking_list_failed");
      }
      renderBookings((payload as { bookings: BookingRow[] }).bookings);
      if (statusElement !== null) statusElement.textContent = "";
    } catch {
      if (statusElement !== null) statusElement.textContent = text("error");
    }
  };

  void loadBookings();
}
