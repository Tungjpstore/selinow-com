import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { getShopForMember } from "../tenants/store";
import type { AppBindings } from "../platform/bindings";

/**
 * EX3.4b — seller-side discount management. Codes are the same `discounts`
 * rows the storefront quote + guarded checkout re-validate atomically; this
 * surface only creates and flips status (forward-only lifecycle, no edits and
 * no hard deletes, mirroring how money-adjacent records are handled).
 */

export type SellerDiscountView = {
  code: string;
  createdAt: string;
  currency: string | null;
  endsAt: string | null;
  id: string;
  minimumMinor: number;
  startsAt: string | null;
  status: "active" | "disabled" | "expired";
  type: "fixed" | "percentage";
  updatedAt: string;
  value: number;
};

const CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/u;

function parseIsoOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AppError("validation_failed", 400, [`${field}_invalid`]);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AppError("validation_failed", 400, [`${field}_invalid`]);
  return new Date(parsed).toISOString();
}

export function parseSellerDiscountInput(body: Record<string, unknown>, shopCurrency: string): {
  code: string;
  currency: string | null;
  endsAt: string | null;
  minimumMinor: number;
  startsAt: string | null;
  type: "fixed" | "percentage";
  value: number;
} {
  if (typeof body.code !== "string") throw new AppError("validation_failed", 400, ["discount_code_invalid"]);
  const code = body.code.trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new AppError("validation_failed", 400, ["discount_code_invalid"]);
  const type = body.type === "percentage" || body.type === "fixed" ? body.type : null;
  if (type === null) throw new AppError("validation_failed", 400, ["discount_type_invalid"]);
  if (typeof body.value !== "number" || !Number.isSafeInteger(body.value) || body.value <= 0) {
    throw new AppError("validation_failed", 400, ["discount_value_invalid"]);
  }
  if (type === "percentage" && body.value > 90) throw new AppError("validation_failed", 400, ["discount_value_invalid"]);
  const minimumMinor = body.minimumMinor === undefined || body.minimumMinor === null ? 0 : body.minimumMinor;
  if (typeof minimumMinor !== "number" || !Number.isSafeInteger(minimumMinor) || minimumMinor < 0) {
    throw new AppError("validation_failed", 400, ["discount_minimum_invalid"]);
  }
  const currency = type === "fixed" ? shopCurrency : null;
  const startsAt = parseIsoOrNull(body.startsAt, "discount_starts_at");
  const endsAt = parseIsoOrNull(body.endsAt, "discount_ends_at");
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    throw new AppError("validation_failed", 400, ["discount_window_invalid"]);
  }
  return { code, currency, endsAt, minimumMinor, startsAt, type, value: body.value };
}

export async function listSellerDiscounts(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<{ discounts: SellerDiscountView[] }> {
  const member = await getShopForMember({ capability: "catalog:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const result = await input.env.PLATFORM_DB.prepare(`
    SELECT id, code_normalized AS code, type, value, currency, minimum_minor AS minimumMinor,
      starts_at AS startsAt, ends_at AS endsAt, status, created_at AS createdAt, updated_at AS updatedAt
    FROM discounts
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).bind(member.row.shop_id).all<SellerDiscountView>();
  return { discounts: result.results };
}

export async function createSellerDiscount(input: {
  body: Record<string, unknown>;
  env: AppBindings;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<SellerDiscountView> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const parsed = parseSellerDiscountInput(input.body, member.row.currency);
  const id = createId("dsc");
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO discounts (id, shop_id, code_normalized, type, value, currency, minimum_minor, starts_at, ends_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).bind(id, member.row.shop_id, parsed.code, parsed.type, parsed.value, parsed.currency, parsed.minimumMinor, parsed.startsAt, parsed.endsAt, nowIso, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at)
      VALUES (?, ?, 'user', ?, 'seller.discount.created', 'discount', ?, ?, ?, ?)
    `).bind(createId("aud"), member.row.shop_id, input.userId, id, JSON.stringify({ code: parsed.code, type: parsed.type, value: parsed.value }), input.requestId, nowIso),
  ];
  try {
    await input.env.PLATFORM_DB.batch(statements);
  } catch {
    throw new AppError("discount_conflict", 409);
  }
  return {
    code: parsed.code,
    createdAt: nowIso,
    currency: parsed.currency,
    endsAt: parsed.endsAt,
    id,
    minimumMinor: parsed.minimumMinor,
    startsAt: parsed.startsAt,
    status: "active",
    type: parsed.type,
    updatedAt: nowIso,
    value: parsed.value,
  };
}

export async function setSellerDiscountStatus(input: {
  discountPublicId: string;
  env: AppBindings;
  nextStatus: "active" | "disabled";
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<SellerDiscountView> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const nowIso = new Date().toISOString();
  const row = await input.env.PLATFORM_DB.prepare(`
    UPDATE discounts
    SET status = ?, updated_at = ?
    WHERE id = ? AND shop_id = ?
    RETURNING id, code_normalized AS code, type, value, currency, minimum_minor AS minimumMinor,
      starts_at AS startsAt, ends_at AS endsAt, status, created_at AS createdAt, updated_at AS updatedAt
  `).bind(input.nextStatus, nowIso, input.discountPublicId, member.row.shop_id).first<SellerDiscountView>();
  if (row === null) throw new AppError("resource_not_found", 404);
  await input.env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at)
    VALUES (?, ?, 'user', ?, ?, 'discount', ?, ?, ?, ?)
  `).bind(createId("aud"), member.row.shop_id, input.userId, input.nextStatus === "disabled" ? "seller.discount.disabled" : "seller.discount.enabled", input.discountPublicId, JSON.stringify({ nextStatus: input.nextStatus }), input.requestId, nowIso).run();
  return row;
}
