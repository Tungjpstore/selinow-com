import { AppError } from "../core/errors";
import { createSystemTranslator } from "../i18n";
import type { AppBindings } from "../platform/bindings";

type MagicLinkEmailBindings = Pick<
  AppBindings,
  "DASHBOARD_ORIGIN" | "EMAIL" | "EMAIL_FROM_ADDRESS" | "EMAIL_FROM_NAME"
>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function sendMagicLinkEmail(input: {
  email: string;
  env: MagicLinkEmailBindings;
  locale?: unknown;
  token: string;
}): Promise<void> {
  const magicLink = new URL("/login", input.env.DASHBOARD_ORIGIN);
  magicLink.hash = new URLSearchParams({ magic: input.token }).toString();
  const link = magicLink.toString();
  const t = createSystemTranslator(input.locale);

  try {
    await input.env.EMAIL.send({
      from: {
        email: input.env.EMAIL_FROM_ADDRESS,
        name: input.env.EMAIL_FROM_NAME,
      },
      html: [
        `<p>${escapeHtml(t("auth.email.requested"))}</p>`,
        `<p><a href="${escapeHtml(link)}">${escapeHtml(t("auth.email.cta"))}</a></p>`,
        `<p>${escapeHtml(t("auth.email.expiry"))}</p>`,
        `<p>${escapeHtml(t("auth.email.ignore"))}</p>`,
      ].join(""),
      subject: t("auth.email.subject"),
      text: [
        t("auth.email.requested"),
        "",
        link,
        "",
        t("auth.email.expiry"),
        t("auth.email.ignore"),
      ].join("\n"),
      to: input.email,
    });
  } catch {
    throw new AppError("provider_unavailable", 503);
  }
}
