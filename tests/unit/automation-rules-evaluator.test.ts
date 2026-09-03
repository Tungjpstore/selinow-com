import { describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import {
  evaluateConditions,
  parseConditions,
  RULE_CONDITION_FIELDS,
  safeEvaluate,
  validateConditionDraft,
} from "../../src/lib/automation/rules/evaluator";
import type { RuleCondition, RuleEventPayload } from "../../src/lib/automation/rules/types";

const ORDER_PAYLOAD: RuleEventPayload = {
  "customer.id": "cust_00000000-0000-4000-8000-000000000001",
  "customer.locale": "vi",
  "order.currency": "VND",
  "order.fulfillment_status": "unfulfilled",
  "order.item_count": 3,
  "order.locale": "vi",
  "order.number": "ORD-1001",
  "order.public_id": "ord_pub_1",
  "order.source_channel": "telegram",
  "order.total_minor": 250_000,
};

function condition(overrides: Partial<RuleCondition>): RuleCondition {
  return {
    field: "order.total_minor",
    operator: "gt",
    value: 100_000,
    ...overrides,
  };
}

describe("rule condition operators", () => {
  it("compares numbers with strict gt/gte/lt/lte boundaries", () => {
    expect(evaluateConditions([condition({ operator: "gt", value: 249_999 })], ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([condition({ operator: "gt", value: 250_000 })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ operator: "gte", value: 250_000 })], ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([condition({ operator: "gte", value: 250_001 })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ operator: "lt", value: 250_001 })], ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([condition({ operator: "lt", value: 250_000 })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ operator: "lte", value: 250_000 })], ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([condition({ operator: "lte", value: 249_999 })], ORDER_PAYLOAD)).toBe(false);
  });

  it("requires matching types for eq/ne (no string/number coercion)", () => {
    expect(evaluateConditions([condition({ field: "order.currency", operator: "eq", value: "VND" })], ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([condition({ field: "order.currency", operator: "eq", value: "vnd" })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ field: "order.currency", operator: "ne", value: "USD" })], ORDER_PAYLOAD)).toBe(true);
    // The stored total is a number; a string value must not silently match.
    expect(evaluateConditions([condition({ operator: "eq", value: "250000" })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ operator: "ne", value: "250000" })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ field: "order.source_channel", operator: "eq", value: true })], ORDER_PAYLOAD)).toBe(false);
  });

  it("matches booleans with eq/ne", () => {
    const payload: RuleEventPayload = { "flag.on": true };
    expect(evaluateConditions([condition({ field: "flag.on", operator: "eq", value: true })], payload)).toBe(true);
    expect(evaluateConditions([condition({ field: "flag.on", operator: "ne", value: false })], payload)).toBe(true);
    expect(evaluateConditions([condition({ field: "flag.on", operator: "eq", value: "true" })], payload)).toBe(false);
  });

  it("performs case-insensitive contains/not_contains/starts_with", () => {
    expect(evaluateConditions([condition({ field: "order.number", operator: "contains", value: "ord-10" })], ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([condition({ field: "order.number", operator: "not_contains", value: "ORD-10" })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ field: "order.number", operator: "starts_with", value: "ORD-" })], ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([condition({ field: "order.number", operator: "starts_with", value: "1001" })], ORDER_PAYLOAD)).toBe(false);
    // Numeric haystacks never match string operators.
    expect(evaluateConditions([condition({ operator: "contains", value: "250" })], ORDER_PAYLOAD)).toBe(false);
  });

  it("supports `in` against string lists for scalar payload values", () => {
    expect(evaluateConditions([condition({ field: "order.source_channel", operator: "in", value: ["web", "telegram"] })], ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([condition({ field: "order.source_channel", operator: "in", value: ["web", "zalo"] })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ field: "customer.locale", operator: "in", value: ["vi"] })], ORDER_PAYLOAD)).toBe(true);
    // Non-scalar actual values can never be members.
    expect(evaluateConditions([condition({ field: "missing.field", operator: "in", value: ["x"] })], ORDER_PAYLOAD)).toBe(false);
  });

  it("AND-combines conditions and treats [] as match-everything", () => {
    const rules: RuleCondition[] = [
      condition({ field: "order.currency", operator: "eq", value: "VND" }),
      condition({ operator: "gte", value: 200_000 }),
    ];
    expect(evaluateConditions(rules, ORDER_PAYLOAD)).toBe(true);
    expect(evaluateConditions([...rules, condition({ field: "order.locale", operator: "eq", value: "en" })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([], ORDER_PAYLOAD)).toBe(true);
  });
});

describe("fail-safe evaluation", () => {
  it("evaluates missing fields to false instead of throwing", () => {
    expect(evaluateConditions([condition({ field: "order.discount_minor", operator: "eq", value: 0 })], ORDER_PAYLOAD)).toBe(false);
    expect(evaluateConditions([condition({ field: "order.discount_minor", operator: "gt", value: 0 })], ORDER_PAYLOAD)).toBe(false);
  });

  it("evaluates wrong-type comparisons to false", () => {
    // gt requires a numeric actual value; the locale field is a string.
    expect(evaluateConditions([condition({ field: "order.locale", operator: "gt", value: 1 })], ORDER_PAYLOAD)).toBe(false);
    // contains requires a string actual value; item_count is a number.
    expect(evaluateConditions([condition({ field: "order.item_count", operator: "contains", value: "3" })], ORDER_PAYLOAD)).toBe(false);
  });

  it("never throws on malformed stored conditions", () => {
    const broken = [
      null,
      undefined,
      "order.total_minor",
      { field: 42, operator: "gt", value: 1 },
      { field: "order.total_minor", operator: "bogus", value: 1 },
      { field: "order.total_minor", operator: "in", value: 1 },
      { field: "order.total_minor", operator: "gt" },
    ] as unknown as RuleCondition[];
    for (const item of broken) {
      expect(safeEvaluate([item], ORDER_PAYLOAD)).toBe(false);
    }
    expect(safeEvaluate(broken as never, ORDER_PAYLOAD)).toBe(false);
    expect(safeEvaluate(ORDER_PAYLOAD as never, ORDER_PAYLOAD)).toBe(false);
  });
});

describe("parseConditions", () => {
  it("parses a valid stored array", () => {
    const parsed = parseConditions(JSON.stringify([
      { field: "order.total_minor", operator: "gte", value: 100_000 },
      { field: "order.source_channel", operator: "in", value: ["web"] },
    ]));
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toEqual({ field: "order.total_minor", operator: "gte", value: 100_000 });
  });

  it("returns null for broken or non-array JSON", () => {
    expect(parseConditions("{not json")).toBeNull();
    expect(parseConditions('{"field":"x"}')).toBeNull();
    expect(parseConditions("null")).toBeNull();
  });

  it("returns null when any item is malformed", () => {
    expect(parseConditions('[{"field":"x","operator":"gt","value":1},{"field":"y"}]')).toBeNull();
    expect(parseConditions('[["field"]]')).toBeNull();
    expect(parseConditions('[{"field":"","operator":"eq","value":1}]')).toBeNull();
    expect(parseConditions('[{"field":"x","operator":"bogus","value":1}]')).toBeNull();
    expect(parseConditions('[{"field":"x","operator":"eq","value":{"nested":true}}]')).toBeNull();
  });
});

describe("validateConditionDraft", () => {
  it("accepts fields on the trigger allow-list only", () => {
    expect(validateConditionDraft("order.paid", { field: "order.total_minor", operator: "gt", value: 1 })).toEqual({
      field: "order.total_minor",
      operator: "gt",
      value: 1,
    });
    expect(RULE_CONDITION_FIELDS["payment.failed"]).toContain("payment.reason");
    expect(() => validateConditionDraft("payment.failed", { field: "order.source_channel", operator: "eq", value: "web" }))
      .toThrow(/validation_failed/u);
    expect(() => validateConditionDraft("order.paid", { field: "payment.reason", operator: "eq", value: "x" }))
      .toThrow(/validation_failed/u);
  });

  it("rejects unknown fields, operators and wrong value types", () => {
    expect(() => validateConditionDraft("order.paid", { extra: 1, field: "order.total_minor", operator: "gt", value: 1 }))
      .toThrow(AppError);
    try {
      validateConditionDraft("order.paid", { extra: 1, field: "order.total_minor", operator: "gt", value: 1 });
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).issues).toContain("unknown_field:extra");
    }
    expect(() => validateConditionDraft("order.paid", { field: "order.total_minor", operator: "regex", value: "x" }))
      .toThrow(/validation_failed/u);
    expect(() => validateConditionDraft("order.paid", { field: "order.total_minor", operator: "gt", value: "100" }))
      .toThrow(/validation_failed/u);
    expect(() => validateConditionDraft("order.paid", { field: "order.currency", operator: "contains", value: "" }))
      .toThrow(/validation_failed/u);
    expect(() => validateConditionDraft("order.paid", { field: "order.currency", operator: "in", value: [] }))
      .toThrow(/validation_failed/u);
    expect(() => validateConditionDraft("order.paid", { field: "order.currency", operator: "in", value: ["ok", 7] }))
      .toThrow(/validation_failed/u);
    expect(() => validateConditionDraft("order.paid", { field: "order.currency", operator: "eq", value: ["VND"] }))
      .toThrow(/validation_failed/u);
    expect(() => validateConditionDraft("order.paid", ["not-an-object"]))
      .toThrow(/validation_failed/u);
  });
});
