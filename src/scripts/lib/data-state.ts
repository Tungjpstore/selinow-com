/**
 * WorkspaceDataState — the EX data-state contract (plan §3.2): every data
 * block on the console renders through exactly these six states. A failed
 * read must never surface as empty/zero.
 */
export type WorkspaceDataState =
  | "ready"
  | "empty"
  | "unavailable"
  | "forbidden"
  | "waiting_provider"
  | "waiting_user";

export type WorkspaceSection<T> = {
  data?: T;
  fetchedAt?: string;
  requestId?: string;
  state: WorkspaceDataState;
};

/** Map a fetch outcome (status/AppError code) onto the contract states. */
export function sectionStateFromResponse(status: number, code?: string): WorkspaceDataState {
  if (status === 403) return code === "recent_auth_required" ? "waiting_user" : "forbidden";
  if (status === 404) return "empty";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "unavailable";
  return "ready";
}

export function isDataState(value: string): value is WorkspaceDataState {
  return value === "ready" || value === "empty" || value === "unavailable"
    || value === "forbidden" || value === "waiting_provider" || value === "waiting_user";
}
