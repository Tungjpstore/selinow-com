export type BillingApiFailure = {
  code: string;
  requestId: string | null;
};

const SAFE_CODE = /^[a-z][a-z0-9._:-]{1,127}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/u;

export function readBillingApiFailure(value: unknown, status: number): BillingApiFailure {
  const object = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    code: typeof object.code === "string" && SAFE_CODE.test(object.code) ? object.code : `http_${String(status)}`,
    requestId: typeof object.requestId === "string" && SAFE_REQUEST_ID.test(object.requestId) ? object.requestId : null,
  };
}

export function isBillingRecentAuthFailure(code: string): boolean {
  return code === "recent_auth_required" || code === "authentication_recent_required";
}
