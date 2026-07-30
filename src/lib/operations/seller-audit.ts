import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

export type SellerAuditEntry = {
  action: string;
  actorType: "platform_admin" | "system" | "user";
  createdAt: string;
  id: string;
  operationId: string | null;
  requestId: string;
  resourceId: string | null;
  resourceType: string;
  retentionClass: "financial" | "legal" | "security" | "standard";
  sourceKind: "application" | "http" | "migration" | "queue" | "scheduled";
};

function safeLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AppError("validation_failed", 400, ["limit_invalid"]);
  return limit;
}

export async function listSellerAuditEntries(input: {
  env: AppBindings;
  limit?: number;
  shopPublicId: string;
  userId: string;
}): Promise<SellerAuditEntry[]> {
  const member = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  if (member.row.role !== "owner") throw new AppError("authorization_denied", 403);
  const limit = safeLimit(input.limit);
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, actor_type AS actorType, action, resource_type AS resourceType,
      resource_id AS resourceId, request_id AS requestId, created_at AS createdAt,
      source_kind AS sourceKind, operation_id AS operationId, retention_class AS retentionClass
    FROM audit_logs
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(member.row.shop_id, limit).all<SellerAuditEntry>();
  return rows.results;
}
