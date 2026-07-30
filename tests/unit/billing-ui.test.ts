import { describe, expect, it } from "vitest";

import { subscriptionStatePresentation } from "../../src/lib/dashboard/billing-ui";

describe("subscription state presentation", () => {
  it("does not present blocked or degraded subscriptions as success", () => {
    expect(subscriptionStatePresentation("active", "vi-VN").tone).toBe("success");
    expect(subscriptionStatePresentation("past_due", "vi-VN").tone).toBe("warning");
    expect(subscriptionStatePresentation("suspended", "vi-VN")).toMatchObject({
      label: "Đã tạm ngưng",
      tone: "danger",
    });
    expect(subscriptionStatePresentation("canceled", "vi-VN").tone).toBe("neutral");
  });

  it("fails closed for an unknown server state", () => {
    expect(subscriptionStatePresentation("provider_transitioning", "vi-VN")).toEqual({
      impact: "Server trả về một trạng thái subscription chưa được nhận diện; không giả định shop đang hoạt động.",
      label: "Chưa xác định",
      tone: "neutral",
    });
  });
});
