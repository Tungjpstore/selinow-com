/**
 * mutate.ts — the single EX mutation scheme (plan §3.3): CSRF + Idempotency-Key
 * handled once, optional optimistic apply with rollback, toast feedback, and
 * structured outcomes so callers never `location.reload()` again.
 *
 * Copy stays with callers: successMessage/errorMessage are pre-localized
 * strings (or omitted to stay silent).
 */
import { csrfCookieName, readCookie } from "./cookie";
import { showToast } from "./toast";

export type MutationOutcome<T> =
  | { code: string; ok: false; requestId?: string; status: number }
  | { data: T; ok: true; replayed: boolean };

export type MutateOptions = {
  body: unknown;
  /** Method-appropriate automatic Idempotency-Key (create-style POSTs). */
  idempotent?: boolean;
  /** Stable caller-owned key (e.g. moderation replay keys) instead of random. */
  idempotencyKey?: string;
  method?: "DELETE" | "PATCH" | "POST" | "PUT";
  onRecentAuth?: () => void;
  optimistic?: () => void;
  url: string;
  errorMessage?: string;
  rollback?: () => void;
  successMessage?: string;
};

type ApiErrorBody = { code?: string; requestId?: string };

function recentAuthRequired(code: string): boolean {
  return code === "recent_auth_required";
}

export async function mutate<T = unknown>(options: MutateOptions): Promise<MutationOutcome<T>> {
  const method = options.method ?? "POST";
  options.optimistic?.();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const csrfName = csrfCookieName();
  const csrf = csrfName === null ? null : readCookie(csrfName);
  if (csrf !== null) headers["X-CSRF-Token"] = csrf;
  if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
  else if (options.idempotent !== false && method === "POST") headers["Idempotency-Key"] = crypto.randomUUID();
  try {
    const response = await fetch(options.url, { body: JSON.stringify(options.body), headers, method });
    const text = await response.text();
    const body: unknown = text === "" ? {} : JSON.parse(text) as unknown;
    const errorBody = (typeof body === "object" && body !== null ? body : {}) as ApiErrorBody;
    if (!response.ok) {
      options.rollback?.();
      const code = typeof errorBody.code === "string" ? errorBody.code : `http_${String(response.status)}`;
      if (recentAuthRequired(code)) options.onRecentAuth?.();
      if (options.errorMessage !== undefined) showToast(options.errorMessage, "danger");
      return {
        ...(typeof errorBody.requestId === "string" ? { requestId: errorBody.requestId } : {}),
        code,
        ok: false,
        status: response.status,
      };
    }
    if (options.successMessage !== undefined) showToast(options.successMessage, "success");
    return {
      data: body as T,
      ok: true,
      replayed: response.status === 200 && method === "POST",
    };
  } catch {
    options.rollback?.();
    if (options.errorMessage !== undefined) showToast(options.errorMessage, "danger");
    return { code: "network_error", ok: false, status: 0 };
  }
}
