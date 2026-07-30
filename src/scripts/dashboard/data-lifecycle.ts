import { createDashboardTranslator } from "../../lib/i18n/catalogs/dashboard";

type ApiPayload = Record<string, unknown> & {
  action?: { newStatus?: unknown };
  code?: string;
  downloadToken?: string;
  export?: { id?: string };
  requestId?: string;
};

type PendingDownload = {
  exportId: string;
  token: string;
};

class ClientApiError extends Error {
  readonly payload: ApiPayload;

  constructor(payload: ApiPayload) {
    super(payload.code ?? "request_failed");
    this.name = "ClientApiError";
    this.payload = payload;
  }
}

const root = document.querySelector<HTMLElement>("[data-data-lifecycle-root]");
const t = createDashboardTranslator(root?.dataset.locale ?? "en");

if (root !== null) {
  const shopPublicId = root.dataset.shopPublicId ?? "";
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const feedback = root.querySelector<HTMLElement>("[data-action-feedback]");
  const retryDownload = root.querySelector<HTMLButtonElement>("[data-retry-download]");
  let pendingDownload: PendingDownload | null = null;

  const csrfToken = (): string => {
    if (csrfCookieName.length === 0) return "";
    const prefix = `${encodeURIComponent(csrfCookieName)}=`;
    const pair = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix));
    if (pair === undefined) return "";
    try {
      return decodeURIComponent(pair.slice(prefix.length));
    } catch {
      return "";
    }
  };

  const idempotencyKey = (scope: string): string => `${scope}-${crypto.randomUUID()}`;

  const moderationIdempotencyKey = (button: HTMLButtonElement, actionKind: string): string => {
    const existing = button.dataset.idempotencyKey;
    if (existing !== undefined && existing !== "") return existing;
    const created = idempotencyKey(`moderation-${actionKind}`);
    button.dataset.idempotencyKey = created;
    return created;
  };

  const setFeedback = (message: string, tone: "danger" | "info" = "info"): void => {
    if (feedback === null) return;
    feedback.hidden = false;
    feedback.dataset.tone = tone;
    feedback.textContent = message;
    feedback.focus({ preventScroll: true });
  };

  const safeMessage = (payload: ApiPayload): string => {
    const messages: Record<string, string> = {
      authentication_required: t("dashboard.data.client.error.authentication_required"),
      abuse_report_not_found: t("dashboard.data.client.error.abuse_report_not_found"),
      authorization_denied: t("dashboard.data.client.error.authorization_denied"),
      csrf_invalid: t("dashboard.data.client.error.csrf_invalid"),
      export_configuration_invalid: t("dashboard.data.client.error.export_configuration_invalid"),
      export_generation_failed: t("dashboard.data.client.error.export_generation_failed"),
      export_state_conflict: t("dashboard.data.client.error.export_state_conflict"),
      idempotency_conflict: t("dashboard.data.client.error.idempotency_conflict"),
      moderation_restore_unavailable: t("dashboard.data.client.error.moderation_restore_unavailable"),
      moderation_state_conflict: t("dashboard.data.client.error.moderation_state_conflict"),
      recent_auth_required: t("dashboard.data.client.error.recent_auth_required"),
      resource_not_found: t("dashboard.data.client.error.resource_not_found"),
      shop_deletion_cancel_blocked: t("dashboard.data.client.error.shop_deletion_cancel_blocked"),
      shop_deletion_legal_hold: t("dashboard.data.client.error.shop_deletion_legal_hold"),
      validation_failed: t("dashboard.data.client.error.validation_failed"),
    };
    const suffix = payload.requestId === undefined ? "" : t("dashboard.data.client.request_code", { requestId: payload.requestId });
    return `${messages[payload.code ?? ""] ?? t("dashboard.data.client.error.generic")}${suffix}`;
  };

  const requestJson = async (path: string, body: Record<string, unknown>, idempotency?: string): Promise<ApiPayload> => {
    const response = await fetch(path, {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken(),
        ...(idempotency === undefined ? {} : { "Idempotency-Key": idempotency }),
      },
      method: "POST",
    });
    const payload = await response.json().catch(() => ({ code: "invalid_response" })) as ApiPayload;
    if (!response.ok) throw new ClientApiError(payload);
    return payload;
  };

  const downloadExport = async (download: PendingDownload): Promise<void> => {
    const response = await fetch(`/api/app/shops/${encodeURIComponent(shopPublicId)}/exports/${encodeURIComponent(download.exportId)}/download`, {
      body: JSON.stringify({ token: download.token }),
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken(),
      },
      method: "POST",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ code: "invalid_response" })) as ApiPayload;
      throw new ClientApiError(payload);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `selinow-${shopPublicId}-export.json`;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    pendingDownload = null;
    if (retryDownload !== null) retryDownload.hidden = true;
  };

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-create-export]")) {
    button.addEventListener("click", () => {
      void (async () => {
      const kind = button.dataset.createExport;
      if (kind !== "standard" && kind !== "inventory_keys_plaintext") return;
      const acknowledgement = root.querySelector<HTMLInputElement>("[data-plaintext-ack]");
      if (kind === "inventory_keys_plaintext" && acknowledgement?.checked !== true) {
        setFeedback(t("dashboard.data.client.export.ack_required"), "danger");
        acknowledgement?.focus();
        return;
      }

      button.disabled = true;
      setFeedback(t("dashboard.data.client.export.creating"));
      try {
        const payload = await requestJson(
          `/api/app/shops/${encodeURIComponent(shopPublicId)}/exports`,
          kind === "standard" ? { kind } : { acknowledgePlaintextRisk: true, kind },
        );
        const exportId = payload.export?.id;
        if (typeof exportId !== "string" || typeof payload.downloadToken !== "string") throw new ClientApiError({ code: "invalid_response" });
        pendingDownload = { exportId, token: payload.downloadToken };
        await downloadExport(pendingDownload);
        setFeedback(t("dashboard.data.client.export.created"));
        window.setTimeout(() => { window.location.reload(); }, 1_200);
      } catch (error) {
        const payload = error instanceof ClientApiError ? error.payload : {};
        setFeedback(safeMessage(payload), "danger");
        if (pendingDownload !== null && retryDownload !== null) retryDownload.hidden = false;
      } finally {
        button.disabled = false;
      }
      })();
    });
  }

  retryDownload?.addEventListener("click", () => {
    void (async () => {
    if (pendingDownload === null) return;
    retryDownload.disabled = true;
    try {
      await downloadExport(pendingDownload);
      setFeedback(t("dashboard.data.client.export.downloaded"));
      window.setTimeout(() => { window.location.reload(); }, 1_200);
    } catch (error) {
      const payload = error instanceof ClientApiError ? error.payload : {};
      setFeedback(safeMessage(payload), "danger");
    } finally {
      retryDownload.disabled = false;
    }
    })();
  });

  root.querySelector<HTMLFormElement>("[data-deletion-request-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
    const data = new FormData(form);
    submit?.setAttribute("disabled", "true");
    setFeedback(t("dashboard.data.client.deletion.creating"));
    void (async () => {
      try {
        await requestJson(`/api/app/shops/${encodeURIComponent(shopPublicId)}/deletion`, {
          confirmation: data.get("confirmation"),
          reasonCode: data.get("reasonCode"),
        });
        setFeedback(t("dashboard.data.client.deletion.created"));
        window.setTimeout(() => { window.location.reload(); }, 900);
      } catch (error) {
        const payload = error instanceof ClientApiError ? error.payload : {};
        setFeedback(safeMessage(payload), "danger");
        submit?.removeAttribute("disabled");
      }
    })();
  });

  const deletionStatus = root.querySelector<HTMLElement>("[data-deletion-id]");

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-moderation-action]")) {
    button.addEventListener("click", () => {
      void (async () => {
        const actionKind = button.dataset.moderationAction;
        const reportPublicId = button.dataset.moderationReport;
        const targetId = button.dataset.targetId;
        if ((actionKind !== "product_suspend" && actionKind !== "product_restore")
          || reportPublicId === undefined || targetId === undefined) return;
        const isRestore = actionKind === "product_restore";
        const confirmed = window.confirm(isRestore
          ? t("dashboard.data.client.moderation.confirm_restore")
          : t("dashboard.data.client.moderation.confirm_suspend"));
        if (!confirmed) return;
        button.disabled = true;
        setFeedback(isRestore
          ? t("dashboard.data.client.moderation.restoring")
          : t("dashboard.data.client.moderation.suspending"));
        try {
          const payload = await requestJson(
            `/api/app/shops/${encodeURIComponent(shopPublicId)}/moderation/actions`,
            { abuseReportPublicId: reportPublicId, actionKind, reasonCode: "reported_abuse", targetId },
            moderationIdempotencyKey(button, actionKind),
          );
          const newStatus = typeof payload.action?.newStatus === "string" ? payload.action.newStatus : null;
          const statusLabel = newStatus === "active"
            ? t("dashboard.data.abuse.target_status.active")
            : newStatus === "draft"
              ? t("dashboard.data.abuse.target_status.draft")
              : newStatus;
          setFeedback(isRestore
            ? newStatus === null
              ? t("dashboard.data.client.moderation.restore_confirmed")
              : t("dashboard.data.client.moderation.restore_confirmed_state", { status: statusLabel ?? "" })
            : t("dashboard.data.client.moderation.suspended"));
          window.setTimeout(() => { window.location.reload(); }, 900);
        } catch (error) {
          const payload = error instanceof ClientApiError ? error.payload : {};
          setFeedback(safeMessage(payload), "danger");
          button.disabled = false;
        }
      })();
    });
  }

  root.querySelector<HTMLButtonElement>("[data-deletion-resume]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    setFeedback(t("dashboard.data.client.deletion.resuming"));
    void (async () => {
      try {
        await requestJson(`/api/app/shops/${encodeURIComponent(shopPublicId)}/deletion/resume`, {});
        window.location.reload();
      } catch (error) {
        const payload = error instanceof ClientApiError ? error.payload : {};
        setFeedback(safeMessage(payload), "danger");
        button.disabled = false;
      }
    })();
  });

  root.querySelector<HTMLButtonElement>("[data-deletion-cancel]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const deletionRequestId = deletionStatus?.dataset.deletionId;
    const expectedVersion = Number(deletionStatus?.dataset.deletionVersion ?? "");
    if (deletionRequestId === undefined || !Number.isSafeInteger(expectedVersion)) return;
    button.disabled = true;
    setFeedback(t("dashboard.data.client.deletion.canceling"));
    void (async () => {
      try {
        await requestJson(
          `/api/app/shops/${encodeURIComponent(shopPublicId)}/deletion/cancel`,
          { deletionRequestId, expectedVersion, reasonCode: "seller_request_canceled" },
          idempotencyKey("delete-cancel"),
        );
        window.location.reload();
      } catch (error) {
        const payload = error instanceof ClientApiError ? error.payload : {};
        setFeedback(safeMessage(payload), "danger");
        button.disabled = false;
      }
    })();
  });
}
