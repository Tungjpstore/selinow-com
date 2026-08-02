export {};

type Copy = Record<string, string>;

const root = document.querySelector<HTMLElement>("[data-members-root]");

if (root !== null) {
  const shopPublicId = root.dataset.shopPublicId;
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const canManage = root.dataset.canManage === "true";
  const copy = (() => {
    try {
      const parsed: unknown = JSON.parse(root.dataset.copy ?? "{}");
      return typeof parsed === "object" && parsed !== null ? parsed as Copy : {};
    } catch {
      return {};
    }
  })();
  const text = (key: string): string => copy[key] ?? "";
  const feedback = root.querySelector<HTMLElement>("[data-members-feedback]");
  let pending = false;

  const readCookie = (name: string): string | null => document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;

  const showFeedback = (message: string, tone: "danger" | "info" | "success" = "info"): void => {
    if (feedback === null) return;
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = message.length === 0;
  };

  const key = (prefix: string): string => {
    try { return `${prefix}_${crypto.randomUUID()}`; }
    catch { return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2)}`; }
  };

  const safeError = async (response: Response): Promise<string> => {
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload === "object" && payload !== null && typeof (payload as { code?: unknown }).code === "string") {
      return (payload as { code: string }).code;
    }
    return text("errorGeneric");
  };

  const request = async (url: string, options: RequestInit): Promise<void> => {
    const csrf = readCookie(csrfCookieName);
    if (csrf === null) throw new Error(text("errorGeneric"));
    const headers = new Headers(options.headers);
    headers.set("X-CSRF-Token", decodeURIComponent(csrf));
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", key("member_ui"));
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    if (!response.ok) throw new Error(await safeError(response));
  };

  const reloadAfter = async (operation: () => Promise<void>, success: string): Promise<void> => {
    if (pending || shopPublicId === undefined || !canManage) return;
    pending = true;
    showFeedback(text("feedbackWorking"), "info");
    try {
      await operation();
      showFeedback(success, "success");
      window.location.reload();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : text("errorGeneric"), "danger");
    } finally {
      pending = false;
    }
  };

  root.querySelector<HTMLButtonElement>("[data-members-open-invite]")?.addEventListener("click", () => {
    root.querySelector<HTMLElement>("[data-invitation-form]")?.scrollIntoView({ behavior: "smooth", block: "center" });
    root.querySelector<HTMLInputElement>("[data-invitation-form] input[name=email]")?.focus();
  });

  root.querySelector<HTMLFormElement>("[data-invitation-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const email = values.get("email");
    const role = values.get("role");
    if (typeof email !== "string" || typeof role !== "string") {
      showFeedback(text("inviteInvalid"), "danger");
      return;
    }
    void reloadAfter(
      () => request(`/api/app/shops/${encodeURIComponent(shopPublicId ?? "")}/members/invitations`, { method: "POST", body: JSON.stringify({ email, role }) }),
      text("inviteSent"),
    );
  });

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const memberRow = target.closest<HTMLElement>("[data-member-row]");
    if (memberRow !== null) {
      const memberPublicId = memberRow.dataset.memberPublicId;
      const version = Number(memberRow.dataset.version);
      if (memberPublicId === undefined || !Number.isSafeInteger(version)) return;
      const role = (memberRow.querySelector<HTMLElement>("[data-member-role]") as HTMLSelectElement | null)?.value;
      if (target.closest("[data-member-save]") !== null && role !== undefined) {
        void reloadAfter(
          () => request(`/api/app/shops/${encodeURIComponent(shopPublicId ?? "")}/members/${encodeURIComponent(memberPublicId)}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: version, role }) }),
          text("feedbackUpdated"),
        );
      }
      if (target.closest("[data-member-suspend]") !== null && window.confirm(text("suspendConfirm"))) {
        void reloadAfter(
          () => request(`/api/app/shops/${encodeURIComponent(shopPublicId ?? "")}/members/${encodeURIComponent(memberPublicId)}`, { method: "DELETE", body: JSON.stringify({ expectedVersion: version }) }),
          text("feedbackUpdated"),
        );
      }
      return;
    }
    const invitationRow = target.closest<HTMLElement>("[data-invitation-row]");
    if (invitationRow === null) return;
    const invitationPublicId = invitationRow.dataset.invitationPublicId;
    const version = Number(invitationRow.dataset.version);
    if (invitationPublicId === undefined || !Number.isSafeInteger(version)) return;
    if (target.closest("[data-invitation-resend]") !== null) {
      void reloadAfter(
        () => request(`/api/app/shops/${encodeURIComponent(shopPublicId ?? "")}/members/invitations/${encodeURIComponent(invitationPublicId)}`, { method: "POST", body: JSON.stringify({ expectedVersion: version }) }),
        text("feedbackUpdated"),
      );
    }
    if (target.closest("[data-invitation-revoke]") !== null && window.confirm(text("invitationConfirm"))) {
      void reloadAfter(
        () => request(`/api/app/shops/${encodeURIComponent(shopPublicId ?? "")}/members/invitations/${encodeURIComponent(invitationPublicId)}`, { method: "DELETE", body: JSON.stringify({ expectedVersion: version }) }),
        text("feedbackUpdated"),
      );
    }
  });
}
