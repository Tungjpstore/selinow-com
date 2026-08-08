export {};

type ApiFailure = { code?: unknown; fingerprint?: unknown; requestId?: unknown };

const ENGLISH_COPY = {
  "deletion.action_invalid": "The legal hold action is invalid. Reload the page.",
  "deletion.confirm_release": "Releasing the legal hold removes the guard that blocks destructive deletion steps. The worker may continue after the grace period. Continue?",
  "deletion.confirm_set": "The legal hold stops provider cleanup, crypto-shred, and finalization. Checkout and routing remain blocked. Continue?",
  "deletion.confirmation_invalid": "Enter {confirmation} exactly to confirm the impact.",
  "deletion.hold_released": "The legal hold was released. Loading the authoritative state...",
  "deletion.hold_releasing": "Releasing the legal hold...",
  "deletion.hold_set": "The backend confirmed the legal hold. Loading the new version...",
  "deletion.hold_setting": "Applying the legal hold...",
  "deletion.hold_until_invalid": "The legal hold must end at a valid time in the future.",
  "deletion.version_invalid": "The deletion request version is invalid. Reload the page.",
  "error.authentication_required": "Your session is no longer valid. Sign in again.",
  "error.authorization_denied": "Your current role cannot perform this action.",
  "error.csrf_invalid": "The action security session is no longer valid. Reload the page.",
  "error.csrf_missing": "The action security session is no longer valid. Reload the page.",
  "error.generic": "The request could not be completed. No change was confirmed in this interface.",
  "error.idempotency_conflict": "The action changed within the same submission. Edit a field before creating a new request.",
  "error.operations_incident_conflict": "The incident changed in another session. Reload before continuing.",
  "error.operations_state_conflict": "The record changed in another session. Reload to get the latest version.",
  "error.operations_validation_failed": "The deletion reference is invalid. Reload the safe projection.",
  "error.recent_auth_required": "Your authentication is too old. Sign in again before this sensitive action.",
  "error.reference_code": " Code {code}.",
  "error.reference_request": " Code {code} - Request {requestId}.",
  "error.resource_not_found": "The public store reference is no longer valid. Reload the page.",
  "error.rotation_operation_pending": "The previous rotation action is still processing. Wait for the latest authoritative state.",
  "error.rotation_state_conflict": "The rotation run changed in another session. Reload before continuing.",
  "error.shop_deletion_legal_hold_conflict": "The deletion request changed version or no longer allows this action. Reload before continuing.",
  "error.shop_deletion_not_found": "The deletion request no longer belongs to the current store reference. Reload the page.",
  "error.validation_failed": "The legal hold data is invalid. Check the time, reason, and evidence reference.",
  "operation.confirm_replay": "Replay restores the linked target and sends it to the queue again with an idempotency guard. Continue?",
  "operation.confirm_resolve": "Resolve closes the active record with the current resolution code. Continue?",
  "operation.replaying": "Requesting replay for the linked target...",
  "operation.updated": "The backend confirmed the action. Loading the latest state...",
  "operation.updating": "Applying the optimistic version guard and recording the audit entry...",
  "rotation.batch_invalid": "Batch size must be between 1 and 100.",
  "rotation.confirm_global": "A global rotation applies across the platform and requires server-side confirmation. Continue?",
  "rotation.confirm_live": "A live rotation rewrites encrypted data with the target key version. Create the guarded run?",
  "rotation.created": "The backend recorded the rotation run. Loading the latest state...",
  "rotation.creating": "Creating the guarded rotation run...",
  "rotation.processed": "The batch completed. Loading authoritative progress...",
  "rotation.processing": "Processing the rotation batch. Do not close or submit the action again...",
  "rotation.shop_required": "A public store ID is required when the scope is one store.",
  "payos.client_id_required": "Enter the controlled staging channel client ID.",
  "payos.fingerprint_copied": "Fingerprint copied for the transient staging secret handoff.",
  "payos.fingerprint_copy_failed": "Could not copy the fingerprint. Copy it manually from this one-time attestation view.",
  "payos.fingerprint_created": "Staging fingerprint accepted. Request {requestId}.",
  "payos.fingerprint_creating": "Deriving the staging fingerprint inside the Worker...",
} as const;

type OperationsCopyKey = keyof typeof ENGLISH_COPY;
type OperationsCopy = Partial<Record<OperationsCopyKey, string>>;
type CopyParams = Readonly<Record<string, string | number>>;

class OperationsError extends Error {
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "OperationsError";
    this.requestId = requestId;
  }
}

function cookieValue(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const normalized = part.trim();
    if (normalized.startsWith(prefix)) return decodeURIComponent(normalized.slice(prefix.length));
  }
  return null;
}

function readOperationsCopy(root: HTMLElement): OperationsCopy {
  try {
    const parsed: unknown = JSON.parse(root.dataset.copy ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    const copy: OperationsCopy = {};
    for (const key of Object.keys(ENGLISH_COPY) as OperationsCopyKey[]) {
      const value = source[key];
      if (typeof value === "string" && value.trim() !== "") copy[key] = value;
    }
    return copy;
  } catch {
    return {};
  }
}

function text(copy: OperationsCopy, key: OperationsCopyKey, params: CopyParams = {}): string {
  const template = copy[key] ?? ENGLISH_COPY[key];
  return template.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu, (placeholder, name: string) => {
    const replacement = params[name];
    return replacement === undefined ? placeholder : String(replacement);
  });
}

function safeErrorMessage(copy: OperationsCopy, code: string): string {
  const key = `error.${code}`;
  return Object.hasOwn(ENGLISH_COPY, key)
    ? text(copy, key as OperationsCopyKey)
    : text(copy, "error.generic");
}

function setFeedback(
  root: HTMLElement,
  copy: OperationsCopy,
  message: string,
  tone: "error" | "neutral" | "success",
  error?: OperationsError,
): void {
  const feedback = root.querySelector<HTMLElement>("[data-feedback]");
  if (feedback === null) return;
  const reference = error === undefined
    ? ""
    : error.requestId === null
      ? text(copy, "error.reference_code", { code: error.message })
      : text(copy, "error.reference_request", { code: error.message, requestId: error.requestId });
  feedback.textContent = `${message}${reference}`;
  feedback.dataset.tone = tone;
  feedback.setAttribute("role", tone === "error" ? "alert" : "status");
}

function idempotencyKey(element: HTMLElement, prefix: string): string {
  const existing = element.dataset.idempotencyKey;
  if (existing !== undefined && existing !== "") return existing;
  const created = `${prefix}_${crypto.randomUUID()}`;
  element.dataset.idempotencyKey = created;
  return created;
}

async function postJson(
  root: HTMLElement,
  endpoint: string,
  body: Record<string, unknown>,
  operationKey: string,
): Promise<{ fingerprint: string | null; requestId: string | null }> {
  const csrf = cookieValue(root.dataset.csrfCookieName ?? "");
  if (csrf === null) throw new OperationsError("csrf_missing", null);
  const response = await fetch(endpoint, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": operationKey,
      "X-CSRF-Token": csrf,
    },
    method: "POST",
  });
  const payload = await response.json().catch(() => ({})) as ApiFailure;
  if (!response.ok) {
    throw new OperationsError(
      typeof payload.code === "string" ? payload.code : `http_${String(response.status)}`,
      typeof payload.requestId === "string" ? payload.requestId : null,
    );
  }
  return {
    fingerprint: typeof payload.fingerprint === "string" && /^[A-Za-z0-9_-]{43}$/u.test(payload.fingerprint) ? payload.fingerprint : null,
    requestId: typeof payload.requestId === "string" ? payload.requestId : null,
  };
}

function setBusy(root: HTMLElement, busy: boolean): void {
  root.setAttribute("aria-busy", String(busy));
}

const root = document.querySelector<HTMLElement>("[data-operations-root]");
if (root !== null) {
  const copy = readOperationsCopy(root);
  const feedback = (
    message: string,
    tone: "error" | "neutral" | "success",
    error?: OperationsError,
  ): void => {
    setFeedback(root, copy, message, tone, error);
  };
  const rotationForm = root.querySelector<HTMLFormElement>("[data-rotation-create-form]");
  const payosFingerprintForm = root.querySelector<HTMLFormElement>("[data-payos-fingerprint-form]");
  const payosFingerprintResult = root.querySelector<HTMLElement>("[data-payos-fingerprint-result]");
  const payosFingerprintValue = root.querySelector<HTMLElement>("[data-payos-fingerprint-value]");
  const payosFingerprintRequest = root.querySelector<HTMLElement>("[data-payos-fingerprint-request]");
  const payosFingerprintCopy = root.querySelector<HTMLButtonElement>("[data-payos-fingerprint-copy]");
  payosFingerprintCopy?.addEventListener("click", () => {
    const fingerprint = payosFingerprintValue?.textContent ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/u.test(fingerprint)) {
      feedback(text(copy, "payos.fingerprint_copy_failed"), "error");
      return;
    }
    void navigator.clipboard.writeText(fingerprint)
      .then(() => {
        feedback(text(copy, "payos.fingerprint_copied"), "success");
      })
      .catch(() => {
        feedback(text(copy, "payos.fingerprint_copy_failed"), "error");
      });
  });
  payosFingerprintForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!payosFingerprintForm.reportValidity()) return;
    const clientIdInput = payosFingerprintForm.elements.namedItem("clientId");
    if (!(clientIdInput instanceof HTMLInputElement) || clientIdInput.value.trim() === "") {
      feedback(text(copy, "payos.client_id_required"), "error");
      return;
    }
    const submit = payosFingerprintForm.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit === null) return;
    submit.disabled = true;
    setBusy(root, true);
    feedback(text(copy, "payos.fingerprint_creating"), "neutral");
    void postJson(root, "/api/admin/payments/payos/staging-fingerprint", { clientId: clientIdInput.value.trim() }, idempotencyKey(payosFingerprintForm, "payos_fingerprint"))
      .then(({ fingerprint, requestId }) => {
        clientIdInput.value = "";
        if (fingerprint === null || payosFingerprintResult === null || payosFingerprintValue === null || payosFingerprintRequest === null) {
          throw new OperationsError("payos_fingerprint_invalid", requestId);
        }
        payosFingerprintValue.textContent = fingerprint;
        payosFingerprintRequest.textContent = requestId === null ? "" : `Request ${requestId}`;
        payosFingerprintResult.hidden = false;
        setBusy(root, false);
        feedback(text(copy, "payos.fingerprint_created", { requestId: requestId ?? "unknown" }), "success");
      })
      .catch((error: unknown) => {
        const safeError = error instanceof OperationsError ? error : new OperationsError("payos_fingerprint_failed", null);
        feedback(safeErrorMessage(copy, safeError.message), "error", safeError);
        submit.disabled = false;
        setBusy(root, false);
      });
  });
  rotationForm?.addEventListener("input", () => {
    delete rotationForm.dataset.idempotencyKey;
  });
  rotationForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const data = new FormData(form);
    const field = (name: string): string => {
      const value = data.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const mode = field("mode");
    const scope = field("scope");
    if (scope === "shop" && field("shopPublicId") === "") {
      feedback(text(copy, "rotation.shop_required"), "error");
      form.querySelector<HTMLInputElement>("[name=shopPublicId]")?.focus();
      return;
    }
    if (mode === "live" && !window.confirm(text(copy, "rotation.confirm_live"))) return;
    if (scope === "global" && !window.confirm(text(copy, "rotation.confirm_global"))) return;

    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit === null) return;
    submit.disabled = true;
    setBusy(root, true);
    feedback(text(copy, "rotation.creating"), "neutral");
    void postJson(root, "/api/admin/operations/rotations", {
      dryRun: mode === "dry",
      globalConfirmation: field("globalConfirmation") || null,
      keyFamily: field("keyFamily"),
      liveConfirmation: field("liveConfirmation") || null,
      scope,
      shopPublicId: field("shopPublicId") || null,
      sourceKeyVersion: field("sourceKeyVersion"),
      targetKeyVersion: field("targetKeyVersion"),
    }, idempotencyKey(form, "rotation_create"))
      .then(() => {
        feedback(text(copy, "rotation.created"), "success");
        window.location.reload();
      })
      .catch((error: unknown) => {
        const safeError = error instanceof OperationsError ? error : new OperationsError("rotation_create_failed", null);
        feedback(safeErrorMessage(copy, safeError.message), "error", safeError);
        submit.disabled = false;
        setBusy(root, false);
      });
  });

  root.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement
      ? event.target.closest<HTMLFormElement>("form[data-deletion-legal-hold-form]")
      : null;
    if (form === null) return;
    event.preventDefault();
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const field = (name: string): string => {
      const value = data.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const action = form.dataset.action;
    if (action !== "set" && action !== "release") {
      feedback(text(copy, "deletion.action_invalid"), "error");
      return;
    }
    const expectedConfirmation = action === "set" ? "LEGAL_HOLD" : "RELEASE_HOLD";
    if (field("confirmation") !== expectedConfirmation) {
      feedback(text(copy, "deletion.confirmation_invalid", { confirmation: expectedConfirmation }), "error");
      form.querySelector<HTMLInputElement>("[name=confirmation]")?.focus();
      return;
    }
    const expectedVersion = Number(form.dataset.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      feedback(text(copy, "deletion.version_invalid"), "error");
      return;
    }
    let holdUntil: string | null = null;
    if (action === "set") {
      const parsedHold = new Date(field("holdUntil"));
      if (!Number.isFinite(parsedHold.getTime()) || parsedHold.getTime() <= Date.now()) {
        feedback(text(copy, "deletion.hold_until_invalid"), "error");
        form.querySelector<HTMLInputElement>("[name=holdUntil]")?.focus();
        return;
      }
      holdUntil = parsedHold.toISOString();
    }
    const impact = action === "set"
      ? text(copy, "deletion.confirm_set")
      : text(copy, "deletion.confirm_release");
    if (!window.confirm(impact)) return;

    const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"));
    controls.forEach((control) => { control.disabled = true; });
    form.setAttribute("aria-busy", "true");
    setBusy(root, true);
    feedback(action === "set" ? text(copy, "deletion.hold_setting") : text(copy, "deletion.hold_releasing"), "neutral");
    void postJson(
      root,
      form.dataset.endpoint ?? "",
      {
        action,
        evidenceReference: field("evidenceReference") || null,
        expectedVersion,
        holdUntil,
        reasonCode: field("reasonCode"),
        shopPublicId: form.dataset.shopPublicId ?? "",
      },
      idempotencyKey(form, "deletion_legal_hold"),
    ).then(() => {
      feedback(action === "set"
        ? text(copy, "deletion.hold_set")
        : text(copy, "deletion.hold_released"), "success");
      window.location.reload();
    }).catch((error: unknown) => {
      const safeError = error instanceof OperationsError ? error : new OperationsError("legal_hold_update_failed", null);
      feedback(safeErrorMessage(copy, safeError.message), "error", safeError);
      controls.forEach((control) => { control.disabled = false; });
      form.setAttribute("aria-busy", "false");
      setBusy(root, false);
    });
  });

  root.addEventListener("click", (event) => {
    const rotationButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-rotation-process]")
      : null;
    if (rotationButton !== null) {
      const record = rotationButton.closest<HTMLElement>("[data-rotation-run]");
      const runId = record?.dataset.rotationRun ?? "";
      const limit = Number(record?.querySelector<HTMLInputElement>("[data-rotation-limit]")?.value ?? "25");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        feedback(text(copy, "rotation.batch_invalid"), "error");
        return;
      }
      rotationButton.disabled = true;
      setBusy(root, true);
      feedback(text(copy, "rotation.processing"), "neutral");
      void postJson(
        root,
        `/api/admin/operations/rotations/${encodeURIComponent(runId)}/process`,
        { limit },
        idempotencyKey(rotationButton, "rotation_process"),
      ).then(() => {
        feedback(text(copy, "rotation.processed"), "success");
        window.location.reload();
      }).catch((error: unknown) => {
        const safeError = error instanceof OperationsError ? error : new OperationsError("rotation_process_failed", null);
        feedback(safeErrorMessage(copy, safeError.message), "error", safeError);
        rotationButton.disabled = false;
        setBusy(root, false);
      });
      return;
    }

    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-action]")
      : null;
    const actions = button?.closest<HTMLElement>("[data-operation-actions]");
    if (button === null || actions === null || actions === undefined) return;
    const action = button.dataset.action ?? "";
    if (action === "resolve" && !window.confirm(text(copy, "operation.confirm_resolve"))) return;
    if (action === "replay" && !window.confirm(text(copy, "operation.confirm_replay"))) return;

    const endpoint = actions.dataset.endpoint ?? "";
    const expectedVersion = Number(actions.dataset.version);
    const shopId = actions.dataset.shopId || null;
    const resolutionCode = actions.closest("article")?.querySelector<HTMLInputElement>("[data-resolution-code]")?.value.trim() ?? "";
    const groupButtons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"));
    groupButtons.forEach((item) => { item.disabled = true; });
    setBusy(root, true);
    feedback(action === "replay"
      ? text(copy, "operation.replaying")
      : text(copy, "operation.updating"), "neutral");
    void postJson(
      root,
      endpoint,
      { action, expectedVersion, resolutionCode, shopId },
      idempotencyKey(button, action === "replay" ? "dead_letter_replay" : "operation"),
    ).then(() => {
      feedback(text(copy, "operation.updated"), "success");
      window.location.reload();
    }).catch((error: unknown) => {
      const safeError = error instanceof OperationsError ? error : new OperationsError("operations_update_failed", null);
      feedback(safeErrorMessage(copy, safeError.message), "error", safeError);
      groupButtons.forEach((item) => { item.disabled = false; });
      setBusy(root, false);
    });
  });

  root.addEventListener("input", (event) => {
    const legalHoldForm = event.target instanceof Element
      ? event.target.closest<HTMLElement>("form[data-deletion-legal-hold-form]")
      : null;
    if (legalHoldForm !== null && legalHoldForm.getAttribute("aria-busy") !== "true") {
      delete legalHoldForm.dataset.idempotencyKey;
    }
    const field = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-resolution-code], [data-rotation-limit]")
      : null;
    if (field === null) return;
    const record = field.closest<HTMLElement>("article");
    record?.querySelectorAll<HTMLElement>("button[data-action], button[data-rotation-process]")
      .forEach((button) => { delete button.dataset.idempotencyKey; });
  });
}
