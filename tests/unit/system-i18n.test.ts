import { describe, expect, it } from "vitest";

import { sendMagicLinkEmail } from "../../src/lib/auth/email";
import { automationErrorMessage, automationStatusLabel } from "../../src/lib/dashboard/automation-ui";
import { subscriptionStatePresentation } from "../../src/lib/dashboard/billing-ui";
import { loadErrorState, safeErrorMessage, statusFor } from "../../src/lib/dashboard/integrations-view";
import { createSystemTranslator } from "../../src/lib/i18n";

type EmailMessage = {
  html: string;
  subject: string;
  text: string;
};

function emailEnv(messages: EmailMessage[]): Parameters<typeof sendMagicLinkEmail>[0]["env"] {
  return {
    DASHBOARD_ORIGIN: "https://app-staging.selinow.com",
    EMAIL: {
      send(message) {
        messages.push(message as EmailMessage);
        return Promise.resolve({ messageId: "localized-message-id" });
      },
    },
    EMAIL_FROM_ADDRESS: "no-reply@selinow.com",
    EMAIL_FROM_NAME: "Selinow",
  };
}

describe("system localization", () => {
  it("resolves English and Vietnamese while unsupported locales fail safely to English", () => {
    expect(createSystemTranslator("en")("status.payment.paid")).toBe("Payment confirmed");
    expect(createSystemTranslator("vi-VN")("status.payment.paid")).toBe("Đã xác nhận thanh toán");
    expect(createSystemTranslator(undefined)("status.payment.paid")).toBe("Payment confirmed");
    expect(createSystemTranslator("fr-FR")("status.payment.paid")).toBe("Payment confirmed");
    expect(createSystemTranslator("en")("internal.machine.key")).toBe("");
  });

  it("never exposes unknown machine status or error codes as user copy", () => {
    expect(statusFor("provider_internal_state", null, "en").label).toBe("Checking");
    expect(loadErrorState("tên miền", "provider_internal_secret", "en").summary).toBe("Could not read domain status.");
    expect(safeErrorMessage("provider_internal_secret", undefined, "en")).toBe("The request could not be completed. Try again.");
    expect(automationErrorMessage("provider_internal_secret", "en")).toBe("The request could not be completed. No false state was shown.");
    expect(automationStatusLabel("waiting_provider", "vi-VN")).toBe("Đang chờ nhà cung cấp");
    expect(subscriptionStatePresentation("provider_internal_state", "en")).toMatchObject({ label: "Unknown", tone: "neutral" });
  });

  it("localizes magic-link email copy and maps provider failures without leaking secrets", async () => {
    const messages: EmailMessage[] = [];
    await sendMagicLinkEmail({
      email: "seller@example.test",
      env: emailEnv(messages),
      locale: "en",
      token: "token-abcdefghijklmnopqrstuvwxyz0123456789",
    });
    await sendMagicLinkEmail({
      email: "seller@example.test",
      env: emailEnv(messages),
      locale: "vi-VN",
      token: "token-abcdefghijklmnopqrstuvwxyz0123456789",
    });

    expect(messages[0]).toMatchObject({ subject: "Sign in to Selinow" });
    expect(messages[0]?.text).toContain("This link expires in 15 minutes");
    expect(messages[1]).toMatchObject({ subject: "Đăng nhập Selinow" });
    expect(messages[1]?.html).toContain("Liên kết này hết hạn sau 15 phút");

    const providerSecret = "provider-secret-must-not-escape";
    let caught: unknown;
    try {
      await sendMagicLinkEmail({
        email: "seller@example.test",
        env: {
          ...emailEnv([]),
          EMAIL: { send: () => Promise.reject(new Error(providerSecret)) },
        },
        locale: "en",
        token: "token-abcdefghijklmnopqrstuvwxyz0123456789",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(JSON.stringify(caught)).not.toContain(providerSecret);
  });
});
