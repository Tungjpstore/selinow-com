import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import { normalizeEmail } from "../auth/policy";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "./store";
import type { ShopRole } from "./policy";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const MEMBER_REF_PATTERN = /^mbr_[A-Za-z0-9_-]{20,128}$/u;
const INVITABLE_ROLES = new Set<Exclude<ShopRole, "owner">>(["manager", "support", "viewer"]);

type MemberRow = {
  createdAt: string;
  displayName: string;
  email: string;
  role: ShopRole;
  status: "active" | "invited" | "suspended";
  memberPublicId: string | null;
  userId: string;
  version: number;
};

type InvitationRow = {
  acceptedAt: string | null;
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  invitedByUserId: string;
  role: Exclude<ShopRole, "owner">;
  status: "accepted" | "expired" | "pending" | "revoked";
  version: number;
};

type ExistingIdempotency = { request_hash: string; response_json: string };

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  }
  return value;
}

function parseRole(value: unknown): Exclude<ShopRole, "owner"> {
  if (typeof value !== "string" || !INVITABLE_ROLES.has(value as Exclude<ShopRole, "owner">)) {
    throw new AppError("validation_failed", 400, ["member_role_invalid"]);
  }
  return value as Exclude<ShopRole, "owner">;
}

function maskEmail(value: string): string {
  const [local, domain] = value.split("@", 2);
  if (local === undefined || domain === undefined || local.length === 0) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function mapMember(input: { env: AppBindings; shopId: string; row: MemberRow }): SellerMemberMutationView {
  if (input.row.memberPublicId === null) throw new AppError("member_reference_unavailable", 500);
  return {
    createdAt: input.row.createdAt,
    displayName: input.row.displayName,
    emailMasked: maskEmail(input.row.email),
    memberPublicId: input.row.memberPublicId,
    role: input.row.role,
    status: input.row.status,
    version: input.row.version,
  };
}

function mapInvitation(row: InvitationRow): MemberInvitationView {
  return {
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
    emailMasked: maskEmail(row.email),
    expiresAt: row.expiresAt,
    invitationPublicId: row.id.replace(/^inv_/, "inv_"),
    role: row.role,
    status: row.status,
    version: row.version,
  };
}

async function sendInvitationEmail(input: { email: string; env: AppBindings; role: Exclude<ShopRole, "owner">; token: string }): Promise<void> {
  const acceptUrl = new URL(`/invite/accept?token=${encodeURIComponent(input.token)}`, input.env.DASHBOARD_ORIGIN).toString();
  await input.env.EMAIL.send({
    from: { email: input.env.EMAIL_FROM_ADDRESS, name: input.env.EMAIL_FROM_NAME },
    html: `<p>You have been invited to join a Selinow shop as ${input.role}.</p><p>Open <a href="${acceptUrl}">this invitation</a> within seven days.</p>`,
    subject: "Selinow shop invitation",
    text: `You have been invited to join a Selinow shop as ${input.role}.\n\n${acceptUrl}\n\nThis invitation expires in seven days.`,
    to: input.email,
  }).catch(() => { throw new AppError("provider_unavailable", 503); });
}

export type SellerMemberMutationView = {
  createdAt: string;
  displayName: string;
  emailMasked: string;
  memberPublicId: string;
  role: ShopRole;
  status: "active" | "invited" | "suspended";
  version: number;
};

export type MemberInvitationView = {
  acceptedAt: string | null;
  createdAt: string;
  emailMasked: string;
  expiresAt: string;
  invitationPublicId: string;
  role: Exclude<ShopRole, "owner">;
  status: "accepted" | "expired" | "pending" | "revoked";
  version: number;
};

export type MemberInvitationIssueResult = {
  debugAcceptToken: string | null;
  invitation: MemberInvitationView;
  replayed: boolean;
};

async function memberRows(env: AppBindings, shopId: string): Promise<MemberRow[]> {
  const existing = await env.PLATFORM_DB.prepare("SELECT user_id AS userId FROM shop_members WHERE shop_id = ? AND member_public_id IS NULL").bind(shopId).all<{ userId: string }>();
  for (const row of existing.results) {
    await env.PLATFORM_DB.prepare("UPDATE shop_members SET member_public_id = ? WHERE shop_id = ? AND user_id = ? AND member_public_id IS NULL").bind(createId("mbr"), shopId, row.userId).run();
  }
  const result = await env.PLATFORM_DB.prepare(`
    SELECT shop_members.user_id AS userId, platform_users.display_name AS displayName,
      platform_users.email_normalized AS email, shop_members.role, shop_members.status,
      shop_members.created_at AS createdAt, shop_members.member_public_id AS memberPublicId,
      shop_members.version
    FROM shop_members
    INNER JOIN platform_users ON platform_users.id = shop_members.user_id
    WHERE shop_members.shop_id = ?
    ORDER BY shop_members.created_at, shop_members.user_id
  `).bind(shopId).all<MemberRow>();
  return result.results;
}

async function resolveMember(input: { env: AppBindings; memberPublicId: string; shopId: string }): Promise<MemberRow> {
  if (!MEMBER_REF_PATTERN.test(input.memberPublicId)) throw new AppError("resource_not_found", 404);
  const rows = await memberRows(input.env, input.shopId);
  for (const row of rows) {
    if (row.memberPublicId === input.memberPublicId) return row;
  }
  throw new AppError("resource_not_found", 404);
}

async function resolveInvitation(env: AppBindings, shopId: string, invitationPublicId: string): Promise<InvitationRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT accepted_at AS acceptedAt, created_at AS createdAt, email_normalized AS email,
      expires_at AS expiresAt, id, invited_by_user_id AS invitedByUserId, role, status, version
    FROM shop_member_invitations
    WHERE shop_id = ? AND public_id = ?
    LIMIT 1
  `).bind(shopId, invitationPublicId).first<InvitationRow>();
}

async function replayInvitation(input: {
  env: AppBindings;
  existing: ExistingIdempotency;
  requestHash: string;
  shopId: string;
}): Promise<MemberInvitationIssueResult> {
  if (input.existing.request_hash !== input.requestHash) throw new AppError("idempotency_conflict", 409);
  const reference = JSON.parse(input.existing.response_json) as { invitationPublicId?: string; shopId?: string };
  if (reference.shopId !== input.shopId || typeof reference.invitationPublicId !== "string") {
    throw new AppError("idempotency_conflict", 409);
  }
  const invitation = await resolveInvitation(input.env, input.shopId, reference.invitationPublicId);
  if (invitation === null) throw new AppError("member_invitation_replay_invalid", 500);
  return { debugAcceptToken: null, invitation: mapInvitation(invitation), replayed: true };
}

export async function listMemberInvitations(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<MemberInvitationView[]> {
  const actor = await getShopForMember({ capability: "team:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT accepted_at AS acceptedAt, created_at AS createdAt, email_normalized AS email,
      expires_at AS expiresAt, id, invited_by_user_id AS invitedByUserId, role, status, version
    FROM shop_member_invitations
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).bind(actor.row.shop_id).all<InvitationRow>();
  return rows.results.map(mapInvitation);
}

export async function issueMemberInvitation(input: {
  email: string;
  env: AppBindings;
  idempotencyKey: string | null;
  requestId: string;
  role: Exclude<ShopRole, "owner">;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<MemberInvitationIssueResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "team:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const email = normalizeEmail(input.email);
  const role = parseRole(input.role);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
  const namespace = `member-invitation.create.v1:${actor.row.shop_id}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "member-invitation-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ email, role, shopId: actor.row.shop_id });
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (existing !== null) return replayInvitation({ env: input.env, existing, requestHash, shopId: actor.row.shop_id });

  const existingMember = await input.env.PLATFORM_DB.prepare(`
    SELECT shop_members.status AS status FROM shop_members
    INNER JOIN platform_users ON platform_users.id = shop_members.user_id
    WHERE shop_members.shop_id = ? AND platform_users.email_normalized = ?
    LIMIT 1
  `).bind(actor.row.shop_id, email).first<{ status: string }>();
  if (existingMember?.status === "active") throw new AppError("member_already_active", 409);
  if (existingMember?.status === "suspended") throw new AppError("member_suspended", 409);

  await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_member_invitations
    SET status = 'expired', updated_at = ?, version = version + 1
    WHERE shop_id = ? AND email_normalized = ? AND status = 'pending' AND expires_at <= ?
  `).bind(nowIso, actor.row.shop_id, email, nowIso).run();
  const pending = await input.env.PLATFORM_DB.prepare(`
    SELECT public_id AS invitationPublicId
    FROM shop_member_invitations
    WHERE shop_id = ? AND email_normalized = ? AND status = 'pending'
    LIMIT 1
  `).bind(actor.row.shop_id, email).first<{ invitationPublicId: string }>();
  if (pending !== null) throw new AppError("member_invitation_pending", 409);

  const invitationId = createId("inv");
  const invitationPublicId = invitationId;
  const token = createOpaqueToken();
  const tokenHash = await hmacToken(input.env.MAGIC_LINK_SECRET, "member-invite:v1", token);
  const replayReference = JSON.stringify({ invitationPublicId, shopId: actor.row.shop_id });
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO shop_member_invitations (
        id, public_id, shop_id, email_normalized, role, status, token_hash,
        invited_by_user_id, expires_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1)
    `).bind(invitationId, invitationPublicId, actor.row.shop_id, email, role, tokenHash, input.userId, expiresAt, nowIso, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) VALUES (?, ?, 'user', ?, 'member.invited', 'member_invitation', ?, ?, ?, 'http', 'security', ?)
    `).bind(createId("aud"), actor.row.shop_id, input.userId, invitationId, JSON.stringify({ emailDomain: email.split("@")[1], role }), input.requestId, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(input.userId, namespace, keyHash, requestHash, replayReference, nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()),
  ]);

  // Delivery follows the durable insert so a provider outage leaves an audited
  // pending invitation that can be explicitly resent.
  await sendInvitationEmail({ email, env: input.env, role, token });

  const invitation = await resolveInvitation(input.env, actor.row.shop_id, invitationPublicId);
  if (invitation === null) throw new AppError("member_invitation_issue_failed", 500);
  return {
    debugAcceptToken: input.env.APP_ENV === "local" ? token : null,
    invitation: mapInvitation(invitation),
    replayed: false,
  };
}

export async function resendMemberInvitation(input: {
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  invitationPublicId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<MemberInvitationView> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "team:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const invitation = await resolveInvitation(input.env, actor.row.shop_id, input.invitationPublicId);
  if (invitation === null) throw new AppError("resource_not_found", 404);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
  const namespace = `member-invitation.resend.v1:${actor.row.shop_id}:${input.invitationPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "member-invitation-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ expectedVersion: input.expectedVersion, invitationPublicId: input.invitationPublicId, shopId: actor.row.shop_id });
  const existing = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (existing !== null) {
    if (existing.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const replay = await resolveInvitation(input.env, actor.row.shop_id, input.invitationPublicId);
    if (replay === null) throw new AppError("member_invitation_replay_invalid", 500);
    return mapInvitation(replay);
  }
  if (invitation.status !== "pending" && invitation.status !== "expired") throw new AppError("member_invitation_not_resendable", 409);
  const token = createOpaqueToken();
  const tokenHash = await hmacToken(input.env.MAGIC_LINK_SECRET, "member-invite:v1", token);
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE shop_member_invitations SET status = 'pending', token_hash = ?, expires_at = ?, updated_at = ?, version = version + 1 WHERE shop_id = ? AND public_id = ? AND status IN ('pending', 'expired') AND version = ?").bind(tokenHash, expiresAt, nowIso, actor.row.shop_id, input.invitationPublicId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) SELECT ?, ?, 'user', ?, 'member.invitation_resent', 'member_invitation', ?, '{}', ?, 'http', 'security', ? WHERE EXISTS (SELECT 1 FROM shop_member_invitations WHERE shop_id = ? AND public_id = ? AND status = 'pending' AND version = ?)").bind(createId("aud"), actor.row.shop_id, input.userId, input.invitationPublicId, input.requestId, nowIso, actor.row.shop_id, input.invitationPublicId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shop_member_invitations WHERE shop_id = ? AND public_id = ? AND status = 'pending' AND version = ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ invitationPublicId: input.invitationPublicId, shopId: actor.row.shop_id }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, input.invitationPublicId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  const updated = await resolveInvitation(input.env, actor.row.shop_id, input.invitationPublicId);
  if (updated === null) throw new AppError("member_invitation_resend_failed", 500);
  await sendInvitationEmail({ email: updated.email, env: input.env, role: updated.role, token });
  return mapInvitation(updated);
}

export async function acceptMemberInvitation(input: {
  env: AppBindings;
  requestId: string;
  token: string;
  userId: string;
  now?: Date;
}): Promise<SellerMemberMutationView> {
  if (input.token.length < 20 || input.token.length > 256) throw new AppError("validation_failed", 400, ["invitation_token_invalid"]);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const tokenHash = await hmacToken(input.env.MAGIC_LINK_SECRET, "member-invite:v1", input.token);
  const invitation = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, email_normalized AS email, role, status, expires_at AS expiresAt
    FROM shop_member_invitations
    WHERE token_hash = ? AND status = 'pending'
    LIMIT 1
  `).bind(tokenHash).first<{ email: string; expiresAt: string; id: string; role: Exclude<ShopRole, "owner">; shopId: string; status: "pending" }>();
  if (invitation === null) throw new AppError("member_invitation_invalid", 404);
  if (invitation.expiresAt <= nowIso) {
    await input.env.PLATFORM_DB.prepare("UPDATE shop_member_invitations SET status = 'expired', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'pending'").bind(nowIso, invitation.id).run();
    throw new AppError("member_invitation_expired", 410);
  }
  const user = await input.env.PLATFORM_DB.prepare("SELECT email_normalized AS email, display_name AS displayName FROM platform_users WHERE id = ? AND status = 'active' LIMIT 1").bind(input.userId).first<{ displayName: string; email: string }>();
  if (user === null || user.email !== invitation.email) throw new AppError("member_invitation_email_mismatch", 403);
  const existing = await input.env.PLATFORM_DB.prepare("SELECT status FROM shop_members WHERE shop_id = ? AND user_id = ? LIMIT 1").bind(invitation.shopId, input.userId).first<{ status: string }>();
  if (existing?.status === "active") throw new AppError("member_already_active", 409);
  if (existing?.status === "suspended") throw new AppError("member_suspended", 409);
  const memberPublicId = createId("mbr");
  const acceptance = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE shop_member_invitations SET status = 'accepted', accepted_user_id = ?, accepted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'pending' AND expires_at > ?").bind(input.userId, nowIso, nowIso, invitation.id, nowIso),
    input.env.PLATFORM_DB.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at, version, member_public_id) SELECT ?, ?, ?, 'active', ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM shop_member_invitations WHERE id = ? AND status = 'accepted' AND accepted_user_id = ?)").bind(invitation.shopId, input.userId, invitation.role, nowIso, nowIso, memberPublicId, invitation.id, input.userId),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) SELECT ?, ?, 'user', ?, 'member.accepted', 'member', ?, ?, ?, 'http', 'security', ? WHERE EXISTS (SELECT 1 FROM shop_member_invitations WHERE id = ? AND status = 'accepted' AND accepted_user_id = ?)").bind(createId("aud"), invitation.shopId, input.userId, input.userId, JSON.stringify({ role: invitation.role }), input.requestId, nowIso, invitation.id, input.userId),
  ]);
  if (acceptance[0]?.meta.changes !== 1 || acceptance[1]?.meta.changes !== 1) {
    throw new AppError("member_invitation_already_used", 409);
  }
  const memberRow = await input.env.PLATFORM_DB.prepare(`
    SELECT shop_members.user_id AS userId, platform_users.display_name AS displayName,
      platform_users.email_normalized AS email, shop_members.role, shop_members.status,
      shop_members.created_at AS createdAt, shop_members.member_public_id AS memberPublicId,
      shop_members.version
    FROM shop_members INNER JOIN platform_users ON platform_users.id = shop_members.user_id
    WHERE shop_members.shop_id = ? AND shop_members.user_id = ? LIMIT 1
  `).bind(invitation.shopId, input.userId).first<MemberRow>();
  if (memberRow === null || memberRow.memberPublicId === null) throw new AppError("member_accept_failed", 500);
  return mapMember({ env: input.env, shopId: invitation.shopId, row: memberRow });
}

export async function revokeMemberInvitation(input: {
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  invitationPublicId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<MemberInvitationView> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "team:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const invitation = await resolveInvitation(input.env, actor.row.shop_id, input.invitationPublicId);
  if (invitation === null) throw new AppError("resource_not_found", 404);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `member-invitation.revoke.v1:${actor.row.shop_id}:${input.invitationPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "member-invitation-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ expectedVersion: input.expectedVersion, invitationPublicId: input.invitationPublicId, shopId: actor.row.shop_id });
  const existing = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (existing !== null) {
    if (existing.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const replay = await resolveInvitation(input.env, actor.row.shop_id, input.invitationPublicId);
    if (replay === null) throw new AppError("member_invitation_replay_invalid", 500);
    return mapInvitation(replay);
  }
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE shop_member_invitations SET status = 'revoked', revoked_at = ?, updated_at = ?, version = version + 1 WHERE shop_id = ? AND public_id = ? AND status = 'pending' AND version = ?").bind(nowIso, nowIso, actor.row.shop_id, input.invitationPublicId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) SELECT ?, ?, 'user', ?, 'member.invitation_revoked', 'member_invitation', ?, ?, ?, 'http', 'security', ? WHERE EXISTS (SELECT 1 FROM shop_member_invitations WHERE shop_id = ? AND public_id = ? AND status = 'revoked' AND version = ?)").bind(createId("aud"), actor.row.shop_id, input.userId, input.invitationPublicId, JSON.stringify({}), input.requestId, nowIso, actor.row.shop_id, input.invitationPublicId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shop_member_invitations WHERE shop_id = ? AND public_id = ? AND status = 'revoked' AND version = ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ invitationPublicId: input.invitationPublicId, shopId: actor.row.shop_id }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, input.invitationPublicId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  const result = await resolveInvitation(input.env, actor.row.shop_id, input.invitationPublicId);
  if (result === null) throw new AppError("member_invitation_revoke_failed", 500);
  return mapInvitation(result);
}

export async function updateMemberRole(input: {
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  memberPublicId: string;
  newRole: Exclude<ShopRole, "owner">;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SellerMemberMutationView> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "team:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const role = parseRole(input.newRole);
  const target = await resolveMember({ env: input.env, memberPublicId: input.memberPublicId, shopId: actor.row.shop_id });
  if (target.userId === input.userId || target.role === "owner") throw new AppError("owner_membership_protected", 409);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `member.role.v1:${actor.row.shop_id}:${input.memberPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "member-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ expectedVersion: input.expectedVersion, memberPublicId: input.memberPublicId, role, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<{ request_hash: string }>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const current = await resolveMember({ env: input.env, memberPublicId: input.memberPublicId, shopId: actor.row.shop_id });
    return mapMember({ env: input.env, shopId: actor.row.shop_id, row: current });
  }
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE shop_members SET role = ?, version = version + 1, updated_at = ? WHERE shop_id = ? AND user_id = ? AND status = 'active' AND version = ?").bind(role, nowIso, actor.row.shop_id, target.userId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) SELECT ?, ?, 'user', ?, 'member.role_changed', 'member', ?, ?, ?, 'http', 'security', ? WHERE EXISTS (SELECT 1 FROM shop_members WHERE shop_id = ? AND user_id = ? AND status = 'active' AND version = ?)").bind(createId("aud"), actor.row.shop_id, input.userId, target.userId, JSON.stringify({ role }), input.requestId, nowIso, actor.row.shop_id, target.userId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shop_members WHERE shop_id = ? AND user_id = ? AND status = 'active' AND version = ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ memberPublicId: input.memberPublicId, shopId: actor.row.shop_id }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, target.userId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  const result = await resolveMember({ env: input.env, memberPublicId: input.memberPublicId, shopId: actor.row.shop_id });
  return mapMember({ env: input.env, shopId: actor.row.shop_id, row: result });
}

export async function suspendMember(input: {
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  memberPublicId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SellerMemberMutationView> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const actor = await getShopForMember({ capability: "team:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const target = await resolveMember({ env: input.env, memberPublicId: input.memberPublicId, shopId: actor.row.shop_id });
  if (target.userId === input.userId || target.role === "owner") throw new AppError("owner_membership_protected", 409);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `member.suspend.v1:${actor.row.shop_id}:${input.memberPublicId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "member-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ expectedVersion: input.expectedVersion, memberPublicId: input.memberPublicId, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<{ request_hash: string }>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const current = await resolveMember({ env: input.env, memberPublicId: input.memberPublicId, shopId: actor.row.shop_id });
    return mapMember({ env: input.env, shopId: actor.row.shop_id, row: current });
  }
  const mutation = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE shop_members SET status = 'suspended', version = version + 1, updated_at = ? WHERE shop_id = ? AND user_id = ? AND status = 'active' AND version = ?").bind(nowIso, actor.row.shop_id, target.userId, input.expectedVersion),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at) SELECT ?, ?, 'user', ?, 'member.suspended', 'member', ?, '{}', ?, 'http', 'security', ? WHERE EXISTS (SELECT 1 FROM shop_members WHERE shop_id = ? AND user_id = ? AND status = 'suspended' AND version = ?)").bind(createId("aud"), actor.row.shop_id, input.userId, target.userId, input.requestId, nowIso, actor.row.shop_id, target.userId, input.expectedVersion + 1),
    input.env.PLATFORM_DB.prepare("INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shop_members WHERE shop_id = ? AND user_id = ? AND status = 'suspended' AND version = ?)").bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ memberPublicId: input.memberPublicId, shopId: actor.row.shop_id }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(), actor.row.shop_id, target.userId, input.expectedVersion + 1),
  ]);
  if (mutation[0]?.meta.changes !== 1 || mutation[1]?.meta.changes !== 1 || mutation[2]?.meta.changes !== 1) throw new AppError("version_conflict", 409);
  const result = await resolveMember({ env: input.env, memberPublicId: input.memberPublicId, shopId: actor.row.shop_id });
  return mapMember({ env: input.env, shopId: actor.row.shop_id, row: result });
}
