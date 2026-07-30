import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Phase A boundary guard. Provider-facing modules may verify, normalize and
 * render, but canonical commerce owns cart, order, inventory and fulfillment state.
 */
const PROVIDER_ROOTS = [
  "src/lib/channels",
  "src/lib/delivery",
  "src/lib/payments",
  "src/lib/telegram",
  "src/pages/webhooks",
] as const;
const TELEGRAM_COMMERCE_PORT = "src/lib/commerce/telegram-port.ts";
const TELEGRAM_RUNTIME = "src/lib/telegram/commerce.ts";
const PURE_PROVIDER_CLIENTS = [
  "src/lib/payments/payos.ts",
  "src/lib/telegram/client.ts",
] as const;

const LEGACY_DIRECT_MUTATIONS = {} as const;

type Mutation = { file: string; kind: string; table: string; operation: "DELETE" | "INSERT" | "UPDATE" };

const FORBIDDEN_MUTATION_PATTERN = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(carts|cart_items|orders|order_items|inventory_keys|fulfillments|fulfillment_items|entitlements)\b/giu;
const FORBIDDEN_STATE_STORE_IMPORT_PATTERN = /\bfrom\s+["'][^"']*\/(?:commerce\/(?:cart-creation|cart-mutation|checkout-transaction|digital-fulfillment|private-file-fulfillment|store)|(?:fulfillment|inventory|orders)\/store)["']/gu;
const FORBIDDEN_TELEGRAM_DISCOUNT_MUTATION_PATTERN = /\bUPDATE\s+carts\s+SET[^;\n]*discount_code_normalized\b/giu;

function providerFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) return providerFiles(filename);
    return entry.isFile() && filename.endsWith(".ts") ? [filename] : [];
  });
}

function mutationKind(operation: Mutation["operation"], table: string, line: string): string {
  if (operation === "INSERT") {
    if (table === "carts") return "create_cart";
    if (table === "cart_items") return "upsert_cart_item";
    if (table === "orders") return "create_order";
    if (table === "order_items") return "create_order_items";
    if (table === "fulfillment_items") return "allocate_key";
    if (table === "fulfillments" && line.includes("'digital_keys'")) return "digital_keys";
    if (table === "fulfillments" && line.includes("'manual'")) return "manual";
  }
  if (operation === "UPDATE" && table === "carts") {
    if (line.includes("state = 'expired'")) return "expire_cart";
    if (line.includes("discount_code_normalized")) return "apply_discount";
    if (line.includes("state = 'converted'")) return "convert_cart";
    if (line.includes("SET updated_at")) return "touch_cart";
  }
  if (operation === "UPDATE" && table === "inventory_keys") {
    const assignedStatus = line.match(/\bSET\s+status\s*=\s*'([^']+)'/iu)?.[1];
    if (assignedStatus === "sold") return "sell";
    if (assignedStatus === "available") return "release";
    if (assignedStatus === "reserved") return "reserve";
  }
  if (operation === "UPDATE" && table === "orders") {
    if (line.includes("status = 'exception'")) return "mark_exception";
    if (line.includes("payment_status = 'paid'")) return "mark_paid";
  }
  return "";
}

function findDirectMutations(): Mutation[] {
  const root = process.cwd();
  const mutations: Mutation[] = [];
  for (const relativeRoot of PROVIDER_ROOTS) {
    for (const filename of providerFiles(join(root, relativeRoot))) {
      const source = readFileSync(filename, "utf8");
      for (const match of source.matchAll(FORBIDDEN_MUTATION_PATTERN)) {
        const operationToken = match[1];
        const table = match[2];
        if (operationToken === undefined || table === undefined) continue;
        const operation: Mutation["operation"] = operationToken.startsWith("INSERT") ? "INSERT" : operationToken.startsWith("UPDATE") ? "UPDATE" : "DELETE";
        const lineStart = source.lastIndexOf("\n", match.index) + 1;
        const lineEnd = source.indexOf("\n", match.index);
        const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).replace(/\s+/gu, " ");
        mutations.push({
          file: relative(root, filename).split("\\").join("/"),
          kind: mutationKind(operation, table, line),
          operation,
          table,
        });
      }
    }
  }
  return mutations;
}

function findDirectStateStoreImports(): string[] {
  const root = process.cwd();
  return PROVIDER_ROOTS.flatMap((relativeRoot) => providerFiles(join(root, relativeRoot)).flatMap((filename) => {
    const source = readFileSync(filename, "utf8");
    return Array.from(source.matchAll(FORBIDDEN_STATE_STORE_IMPORT_PATTERN), (match) => `${relative(root, filename).split("\\").join("/")}|${match[0]}`);
  }));
}

function findTelegramCheckoutMutations(): string[] {
  const root = process.cwd();
  const filename = join(root, TELEGRAM_COMMERCE_PORT);
  const source = readFileSync(filename, "utf8");
  const tableMutations = Array.from(source.matchAll(FORBIDDEN_MUTATION_PATTERN))
    // Telegram still owns principal cart lifecycle creation/expiry; shared
    // mutation and checkout cores own cart items, discounts and order state.
    .filter((match) => match[2] !== "carts")
    .map((match) => `${TELEGRAM_COMMERCE_PORT}|${match[0]}`);
  const discountMutations = Array.from(source.matchAll(FORBIDDEN_TELEGRAM_DISCOUNT_MUTATION_PATTERN), (match) => `${TELEGRAM_COMMERCE_PORT}|${match[0]}`);
  return [...tableMutations, ...discountMutations];
}

function mutationCounts(mutations: readonly Mutation[]): Record<string, number> {
  return mutations.reduce<Record<string, number>>((counts, mutation) => {
    const key = [mutation.file, mutation.operation, mutation.table, mutation.kind].filter(Boolean).join("|");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

describe("Phase A provider adapter commerce boundary", () => {
  it("routes Telegram order and payment capabilities through the composed application", () => {
    const source = readFileSync(join(process.cwd(), TELEGRAM_RUNTIME), "utf8");
    expect(source).not.toContain("listTelegramOrders");
    expect(source).toContain("orderApplication.listOrders");
    expect(source).toContain("application.createPaymentHandoff");
    expect(source).toContain("application.getFulfillmentEligibility");
    expect(source).toContain("input.application.revealFulfillment");
  });

  it("rejects provider-side commerce state writes after canonical cutover", () => {
    const actual = mutationCounts(findDirectMutations());

    // Keep this as an allowlist so a provider-side state write cannot return
    // unnoticed after the Telegram and PayOS cutovers.
    expect(actual).toEqual(LEGACY_DIRECT_MUTATIONS);
  });

  it("rejects provider imports of canonical commerce mutation sinks or state stores", () => {
    expect(findDirectStateStoreImports()).toEqual([]);
  });

  it("keeps Telegram checkout/order/inventory/fulfillment writes in the shared transaction core", () => {
    expect(findTelegramCheckoutMutations()).toEqual([]);
  });

  it("keeps provider I/O clients free of authoritative commerce state access", () => {
    for (const relativeFilename of PURE_PROVIDER_CLIENTS) {
      const source = readFileSync(join(process.cwd(), relativeFilename), "utf8");

      // Provider I/O leaves may parse, authenticate and call an external API;
      // orchestration modules perform all D1 state changes after normalization.
      expect(source).not.toMatch(/\b(?:D1Database|AppBindings|PLATFORM_DB)\b/u);
      expect(source).not.toMatch(/from\s+["'][^"']*\/(?:commerce|payments\/(?:store|webhooks|reconciliation|decision))["']/u);
      expect(source).not.toMatch(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\b/iu);
    }
  });
});
