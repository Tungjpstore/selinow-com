import type { AppBindings } from "../platform/bindings";
import type { AutomationExecutor } from "./types";

const SHOP_REFERENCE = /^d1:shop\/([A-Za-z0-9][A-Za-z0-9._:-]{2,127})$/u;

function shopIdFromReference(inputReference: string, expectedShopId: string): string | null {
  const match = SHOP_REFERENCE.exec(inputReference);
  if (match === null || match[1] !== expectedShopId) return null;
  return match[1];
}

async function verifyShopProvision(
  env: AppBindings,
  reference: { inputReference: string; shopId: string },
): Promise<"completed" | "retry" | "failed"> {
  const shopId = shopIdFromReference(reference.inputReference, reference.shopId);
  if (shopId === null) return "failed";
  const row = await env.PLATFORM_DB.prepare(`
    SELECT status
    FROM shops
    WHERE id = ?
    LIMIT 1
  `).bind(shopId).first<{ status: string }>();
  if (row === null) return "failed";
  return row.status === "archived" ? "failed" : "completed";
}

async function verifyPlatformDomain(
  env: AppBindings,
  reference: { inputReference: string; shopId: string },
): Promise<"completed" | "retry" | "failed"> {
  const shopId = shopIdFromReference(reference.inputReference, reference.shopId);
  if (shopId === null) return "failed";
  const row = await env.PLATFORM_DB.prepare(`
    SELECT status
    FROM shop_domains
    WHERE shop_id = ? AND type = 'platform_subdomain'
    LIMIT 1
  `).bind(shopId).first<{ status: string }>();
  if (row === null) return "retry";
  if (row.status === "active") return "completed";
  if (row.status === "deleted" || row.status === "suspended") return "failed";
  return "retry";
}

/**
 * These executors only verify Selinow-owned state. Provider side effects stay
 * behind explicit adapters and are represented as waiting tasks until consent
 * and provider evidence exist.
 */
export function createAutomationExecutors(env: AppBindings): ReadonlyMap<string, AutomationExecutor> {
  const verifyShop: AutomationExecutor = async (reference) => {
    const result = await verifyShopProvision(env, reference);
    if (result === "completed") return { outcome: "completed" };
    if (result === "failed") return { outcome: "failed", safeErrorCode: "automation_shop_invalid" };
    return { outcome: "retry", safeErrorCode: "automation_shop_unavailable" };
  };

  const verifyDomain: AutomationExecutor = async (reference) => {
    const result = await verifyPlatformDomain(env, reference);
    if (result === "completed") return { outcome: "completed" };
    if (result === "failed") return { outcome: "failed", safeErrorCode: "automation_domain_invalid" };
    return { outcome: "retry", safeErrorCode: "automation_domain_unavailable" };
  };

  return new Map<string, AutomationExecutor>([
    ["shop.provision", verifyShop],
    ["domain.platform.provision", verifyDomain],
  ]);
}
