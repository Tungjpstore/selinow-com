import { constantTimeEqual, hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_STATE = /^[A-Za-z0-9_-]{43,128}$/u;

function invalid(issue: string): never {
  throw new AppError("zalo_oa_oauth_invalid", 400, [issue]);
}

function requireReference(value: unknown, issue: string): string {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) invalid(issue);
  return value;
}

function requireState(value: unknown): string {
  if (typeof value !== "string" || !SAFE_STATE.test(value)) invalid("state_invalid");
  return value;
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512) invalid("state_secret_invalid");
  return value;
}

function purpose(shopId: string, connectorRequestId: string): string {
  return `zalo-oa-oauth-state:v1:${shopId}:${connectorRequestId}`;
}

/**
 * Derives the only state value that should be persisted for a pending OA
 * connector. Persist this hash with a one-use/expiry constraint; never store
 * the raw browser state or PKCE verifier in an audit, queue, or projection.
 */
export async function hashZaloOfficialAccountOAuthState(input: {
  connectorRequestId: string;
  sessionSecret: string;
  shopId: string;
  state: string;
}): Promise<string> {
  const shopId = requireReference(input.shopId, "shop_id_invalid");
  const connectorRequestId = requireReference(input.connectorRequestId, "connector_request_id_invalid");
  const state = requireState(input.state);
  const secret = requireSecret(input.sessionSecret);
  return hmacToken(secret, purpose(shopId, connectorRequestId), state);
}

export async function verifyZaloOfficialAccountOAuthStateHash(input: {
  connectorRequestId: string;
  expectedHash: string;
  receivedState: string;
  sessionSecret: string;
  shopId: string;
}): Promise<void> {
  if (typeof input.expectedHash !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.expectedHash)) invalid("state_hash_invalid");
  const candidate = await hashZaloOfficialAccountOAuthState({
    connectorRequestId: input.connectorRequestId,
    sessionSecret: input.sessionSecret,
    shopId: input.shopId,
    state: input.receivedState,
  });
  if (!constantTimeEqual(candidate, input.expectedHash)) invalid("state_mismatch");
}
