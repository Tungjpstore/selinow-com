import { issueZaloOfficialAccountOAuthState } from "./zalo-oa-oauth-state-store";
import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

const PROVIDER_CODE = "zalo.oa" as const;
const CONNECTOR_REQUEST_PUBLIC_ID = /^creq_[0-9a-f-]{36}$/u;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const MAX_REDIRECT_URI_LENGTH = 2048;

function validation(issue: string): never {
  throw new AppError("validation_failed", 400, [issue]);
}

function requireText(value: unknown, issue: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) validation(issue);
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) validation(issue);
  }
  return value;
}

function requireReference(value: unknown, issue: string): string {
  const candidate = requireText(value, issue, 128);
  if (!SAFE_REFERENCE.test(candidate)) validation(issue);
  return candidate;
}

function requireConnectorRequestPublicId(value: unknown): string {
  const candidate = requireText(value, "connector_request_public_id_invalid", 96);
  if (!CONNECTOR_REQUEST_PUBLIC_ID.test(candidate)) validation("connector_request_public_id_invalid");
  return candidate;
}

function requireRedirectUri(value: unknown): string {
  const candidate = requireText(value, "redirect_uri_invalid", MAX_REDIRECT_URI_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    validation("redirect_uri_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    validation("redirect_uri_invalid");
  }
  return candidate;
}

function requireApprovedRedirectUri(value: unknown, env: AppBindings): string {
  const candidate = requireRedirectUri(value);
  const approved = new Set<string>();
  for (const origin of [env.API_ORIGIN, env.DASHBOARD_ORIGIN]) {
    if (typeof origin !== "string" || origin.length === 0) continue;
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.protocol !== "https:" && !(env.APP_ENV === "local" && parsedOrigin.protocol === "http:")) continue;
      approved.add(new URL("/api/channels/zalo-oa/callback", parsedOrigin).toString());
    } catch {
      // Invalid deployment bindings leave the allowlist empty and fail closed.
    }
  }
  if (!approved.has(candidate)) validation("redirect_uri_not_allowed");
  return candidate;
}

function requireAuthorizationCode(value: unknown): string {
  return requireText(value, "authorization_code_invalid", 1024);
}

function requireState(value: unknown): string {
  const candidate = requireText(value, "state_invalid", 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(candidate)) validation("state_invalid");
  return candidate;
}

export type StartZaloOfficialAccountOAuthInput = {
  appId: unknown;
  connectorRequestPublicId: unknown;
  env: AppBindings;
  redirectUri: unknown;
  shopPublicId: string;
  userId: string;
};

export async function startZaloOfficialAccountOAuth(input: StartZaloOfficialAccountOAuthInput) {
  const actor = await getShopForMember({
    capability: "integrations:credentials",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  if (actor.row.shop_status === "suspended" || actor.row.shop_status === "archived") {
    throw new AppError("tenant_suspended", 403);
  }

  const connectorRequestPublicId = requireConnectorRequestPublicId(input.connectorRequestPublicId);
  const connector = await input.env.PLATFORM_DB.prepare(`
    SELECT id
    FROM channel_connector_requests
    WHERE shop_id = ? AND public_id = ?
      AND channel_code = ? AND provider_code = ?
      AND status IN ('requested', 'provider_pending', 'active')
    LIMIT 1
  `).bind(actor.row.shop_id, connectorRequestPublicId, PROVIDER_CODE, PROVIDER_CODE).first<{ id: string }>();
  if (connector === null) throw new AppError("channel_connector_request_not_found", 404);

  return issueZaloOfficialAccountOAuthState({
    ...input.env,
    appId: requireReference(input.appId, "app_id_invalid"),
    connectorRequestId: connector.id,
    redirectUri: requireApprovedRedirectUri(input.redirectUri, input.env),
    shopId: actor.row.shop_id,
  });
}

export type CompleteZaloOfficialAccountOAuthInput = {
  authorizationCode: unknown;
  env: AppBindings;
  officialAccountId?: unknown;
  receivedState: unknown;
};

function requireProviderIdentity(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new AppError("zalo_oa_oauth_invalid", 400, ["oa_id_invalid"]);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) {
      throw new AppError("zalo_oa_oauth_invalid", 400, ["oa_id_invalid"]);
    }
  }
  return value;
}

/**
 * The public callback is intentionally fail-closed until a reviewed,
 * server-side Zalo credential binding exists. Never accept an app secret or
 * OA identity from the browser, and never consume one-use state before that
 * binding is available.
 */
export function completeZaloOfficialAccountOAuth(input: CompleteZaloOfficialAccountOAuthInput): Promise<never> {
  requireAuthorizationCode(input.authorizationCode);
  requireState(input.receivedState);
  if (input.officialAccountId !== undefined) requireProviderIdentity(input.officialAccountId);
  return Promise.reject(new AppError("channel_provider_pending", 409, [PROVIDER_CODE]));
}
