import { describe, expect, it } from "vitest";

import { dashboardCatalogs } from "../../src/lib/i18n/catalogs/dashboard";

describe("store builder publication error handling and readiness blockers", () => {
  it("provides distinct localized copy for draft save failure vs publish blocked and publish failure", () => {
    const en = dashboardCatalogs["en"];
    const vi = dashboardCatalogs["vi-VN"];

    // Draft save failure
    expect(en["dashboard.store_builder.runtime.failed"]).toBe("Save failed");
    expect(vi["dashboard.store_builder.runtime.failed"]).toBe("Lưu lỗi");

    // Publish blocked due to readiness
    expect(en["dashboard.store_builder.runtime.publish_blocked"]).toBe("Publish blocked");
    expect(vi["dashboard.store_builder.runtime.publish_blocked"]).toBe("Chưa thể xuất bản");

    // Publish failure due to server / conflict
    expect(en["dashboard.store_builder.runtime.publish_failed_badge"]).toBe("Publish failed");
    expect(vi["dashboard.store_builder.runtime.publish_failed_badge"]).toBe("Xuất bản lỗi");

    // Blockers modal dialog copy
    expect(en["dashboard.store_builder.blockers_dialog.title"]).toBe("Storefront cannot be published yet");
    expect(vi["dashboard.store_builder.blockers_dialog.title"]).toBe("Chưa thể xuất bản cửa hàng");

    expect(en["dashboard.store_builder.blockers_dialog.description"]).toContain("readiness");
    expect(vi["dashboard.store_builder.blockers_dialog.description"]).toContain("điều kiện sau");

    expect(en["dashboard.store_builder.blockers_dialog.action_onboarding"]).toBe("Complete store setup");
    expect(vi["dashboard.store_builder.blockers_dialog.action_onboarding"]).toBe("Hoàn tất thiết lập cửa hàng");

    expect(en["dashboard.store_builder.blockers_dialog.action_fix"]).toBe("Fix");
    expect(vi["dashboard.store_builder.blockers_dialog.action_fix"]).toBe("Cấu hình");

    expect(en["dashboard.store_builder.blockers_dialog.close"]).toBe("Close");
    expect(vi["dashboard.store_builder.blockers_dialog.close"]).toBe("Đóng");

    expect(en["dashboard.store_builder.blockers_dialog.required_badge"]).toBe("Required");
    expect(vi["dashboard.store_builder.blockers_dialog.required_badge"]).toBe("Bắt buộc");
  });

  it("ensures publication blocked status is never confused with draft save failed status", () => {
    const vi = dashboardCatalogs["vi-VN"];
    expect(vi["dashboard.store_builder.runtime.publish_blocked"]).not.toBe(vi["dashboard.store_builder.runtime.failed"]);
    expect(vi["dashboard.store_builder.runtime.publish_failed_badge"]).not.toBe(vi["dashboard.store_builder.runtime.failed"]);
    expect(vi["dashboard.store_builder.runtime.publish_blocked"]).not.toContain("Lưu");
  });
});
