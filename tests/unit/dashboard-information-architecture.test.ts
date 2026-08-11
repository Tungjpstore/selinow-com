import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspace = resolve(import.meta.dirname, "../..");
const iaPath = resolve(workspace, "docs/frontend-rebuild-handoff/DASHBOARD_INFORMATION_ARCHITECTURE.md");
const acceptancePath = resolve(workspace, "docs/frontend-rebuild-handoff/ACCEPTANCE_MATRIX.csv");

describe("dashboard information architecture handoff", () => {
  it("documents the private shell and every isolated provider lane", () => {
    expect(existsSync(iaPath)).toBe(true);
    const ia = readFileSync(iaPath, "utf8");
    for (const required of [
      "Command",
      "Commerce",
      "Channels",
      "Operations",
      "Workspace",
      "Telegram Bot",
      "Telegram Mini App",
      "Zalo Mini App",
      "Zalo OA",
      "WhatsApp Cloud",
      "Discord Bot",
      "provider_pending",
      "activated/accepted",
      "0067",
    ]) {
      expect(ia).toContain(required);
    }
    expect(ia).toContain("156-row `API_ENDPOINT_INDEX.csv`");
    expect(ia).toContain("25 logical routes + 2 aliases");
  });

  it("keeps acceptance scenarios for each provider lane and automation wait", () => {
    const acceptance = readFileSync(acceptancePath, "utf8");
    for (const scenario of [
      "telegram_bot_lane",
      "telegram_mini_app_lane",
      "zalo_mini_app_lane",
      "zalo_oa_lane",
      "whatsapp_cloud_lane",
      "discord_bot_lane",
      "provider_wait_group",
    ]) {
      expect(acceptance).toContain(`,${scenario},`);
    }
  });
});
