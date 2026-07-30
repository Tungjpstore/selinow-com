import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  automationErrorMessage,
  automationStatusLabel,
  automationStatusTone,
  automationTaskLabel,
  automationTaskImpact,
  canManageAutomationTask,
  canResumeAutomationTask,
  parseAutomationTasks,
  type AutomationTaskView,
} from "../../src/lib/dashboard/automation-ui";

const task: AutomationTaskView = {
  actionUrl: "/onboarding#readiness",
  attemptCount: 0,
  capabilityCode: "shop.provision",
  canCancel: true,
  continuation: { kind: "approval_granted" },
  createdAt: "2026-07-29T00:00:00.000Z",
  id: "task-a",
  lastSafeErrorCode: null,
  nextAttemptAt: null,
  status: "waiting_user",
  updatedAt: "2026-07-29T00:00:00.000Z",
  version: 1,
};

describe("automation UI projection", () => {
  it("accepts only safe public task projections", () => {
    expect(parseAutomationTasks({ tasks: [task] })).toEqual([task]);
    expect(parseAutomationTasks({ tasks: [{ ...task, actionUrl: "https://provider.example/continue" }] })).toEqual([]);
    expect(parseAutomationTasks({ tasks: [{ ...task, actionUrl: "//provider.example/continue" }] })).toEqual([]);
    expect(parseAutomationTasks({ tasks: [{ ...task, continuation: { kind: "approval_granted", evidenceToken: "secret" } }] })).toEqual([task]);
    expect(parseAutomationTasks({ tasks: [{ ...task, version: 0 }] })).toEqual([]);
    expect(parseAutomationTasks({ tasks: [{ ...task, canCancel: "yes" }] })).toEqual([]);
    expect(parseAutomationTasks({ tasks: [{ ...task, lastSafeErrorCode: "provider payload leaked" }] })).toEqual([]);
  });

  it("exposes resume only for server-projected continuation states", () => {
    expect(canResumeAutomationTask(task)).toBe(true);
    expect(canResumeAutomationTask({ ...task, continuation: null, status: "waiting_user" })).toBe(false);
    expect(canResumeAutomationTask({ ...task, status: "succeeded" })).toBe(false);
    expect(canManageAutomationTask(task, "owner")).toBe(true);
    expect(canManageAutomationTask({ ...task, capabilityCode: "domain.platform.provision" }, "manager")).toBe(false);
    expect(canManageAutomationTask(task, "support")).toBe(false);
    expect(canManageAutomationTask(task, "viewer")).toBe(false);
  });

  it("keeps safe operational copy bounded to known states", () => {
    expect(automationTaskLabel(task)).toBe("Provision store resources");
    expect(automationTaskLabel(task, "vi-VN")).toBe("Cấp tài nguyên cửa hàng");
    expect(automationTaskLabel({ capabilityCode: "provider.internal.task" }, "vi-VN")).toBe("Tác vụ thiết lập nền tảng");
    expect(automationStatusLabel("waiting_provider")).toBe("Waiting for provider");
    expect(automationStatusTone("waiting_provider")).toBe("warning");
    expect(automationTaskImpact({ status: "waiting_provider", nextAttemptAt: null }, "vi-VN")).toContain("bằng chứng mới");
    expect(automationTaskImpact({ status: "retryable", nextAttemptAt: "2026-07-29T00:05:00.000Z" }, "vi-VN")).toContain("thử lại");
    expect(automationErrorMessage("automation_provider_evidence_pending", "vi-VN")).toContain("Chưa có bằng chứng mới");
  });

  it("keeps reusable automation metadata free of embedded localized copy", async () => {
    const source = await readFile("src/lib/dashboard/automation-ui.ts", "utf8");
    expect(source).not.toMatch(/[À-ỹĐđ]/u);
  });

  it("keeps the page and controller tenant-bound and evidence-token-free", async () => {
    const [page, component, controller] = await Promise.all([
      readFile("src/pages/app/automation.astro", "utf8"),
      readFile("src/components/dashboard/AutomationLedger.astro", "utf8"),
      readFile("src/scripts/dashboard/automation.ts", "utf8"),
    ]);
    expect(page).toContain("listAutomationTasks");
    expect(page).toContain('import { withSelectedShop } from "../../lib/dashboard/shop-navigation";');
    expect(page).toContain("const workspaceHref = (href: string): string => withSelectedShop(href, shop?.publicId, Astro.url.origin);");
    expect(page).toContain("selectedShopPublicId={shop.publicId}");
    expect(component).toContain("data-shop-public-id={selectedShopPublicId}");
    expect(component).toContain("data-task-version={task.version}");
    expect(controller).toContain("?limit=20");
    expect(controller).toContain('"X-CSRF-Token"');
    expect(controller).toContain('"Idempotency-Key"');
    expect(controller).toContain("expectedVersion: version");
    expect(controller).not.toContain("evidenceToken");
  });
});
