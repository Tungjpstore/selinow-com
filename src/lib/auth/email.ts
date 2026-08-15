import { AppError } from "../core/errors";
import { createSystemTranslator } from "../i18n";
import type { AppBindings } from "../platform/bindings";
import type { OtpPurpose } from "./otp";

type EmailBindings = Pick<
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
  env: EmailBindings;
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

export async function sendOtpEmail(input: {
  email: string;
  env: EmailBindings;
  locale?: unknown;
  otp: string;
  purpose: OtpPurpose;
  ttlMinutes?: number;
}): Promise<void> {
  const t = createSystemTranslator(input.locale);
  const ttl = input.ttlMinutes ?? 10;

  const subject =
    input.purpose === "password_reset"
      ? t("auth.email.otp_reset_subject")
      : input.purpose === "login_2fa"
        ? t("auth.email.otp_2fa_subject")
        : t("auth.email.otp_register_subject");

  const heading =
    input.purpose === "password_reset"
      ? t("auth.email.otp_reset_heading")
      : input.purpose === "login_2fa"
        ? t("auth.email.otp_2fa_heading")
        : t("auth.email.otp_register_heading");

  const otpCode = input.otp;
  const expiryText = t("auth.email.otp_expiry", { minutes: String(ttl) });
  const ignoreText = t("auth.email.ignore");

  try {
    await input.env.EMAIL.send({
      from: {
        email: input.env.EMAIL_FROM_ADDRESS,
        name: input.env.EMAIL_FROM_NAME,
      },
      html: [
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1E293B; background: #FFFFFF; border-radius: 8px; border: 1px solid #E2E8F0;">`,
        `<div style="margin-bottom: 20px;"><strong style="font-size: 20px; color: #0F172A;">Selinow</strong></div>`,
        `<h2 style="font-size: 18px; margin-top: 0; color: #0F172A;">${escapeHtml(heading)}</h2>`,
        `<p style="margin: 16px 0 8px; font-size: 14px; color: #475569;">${escapeHtml(t("auth.email.otp_instruction"))}</p>`,
        `<div style="margin: 24px 0; padding: 16px; background: #F8FAFC; border: 1px dashed #CBD5E1; border-radius: 8px; text-align: center;">`,
        `<span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; font-family: monospace; color: #2563EB;">${escapeHtml(otpCode)}</span>`,
        `</div>`,
        `<p style="margin: 8px 0; font-size: 13px; color: #64748B;">${escapeHtml(expiryText)}</p>`,
        `<p style="margin: 8px 0 0; font-size: 13px; color: #94A3B8;">${escapeHtml(ignoreText)}</p>`,
        `</div>`,
      ].join(""),
      subject,
      text: [
        heading,
        "",
        `${t("auth.email.otp_instruction")}: ${otpCode}`,
        "",
        expiryText,
        ignoreText,
      ].join("\n"),
      to: input.email,
    });
  } catch {
    throw new AppError("provider_unavailable", 503);
  }
}

export async function sendPasswordChangedAlertEmail(input: {
  email: string;
  env: EmailBindings;
  locale?: unknown;
}): Promise<void> {
  const t = createSystemTranslator(input.locale);
  const subject = t("auth.email.password_changed_subject");
  const message = t("auth.email.password_changed_body");

  try {
    await input.env.EMAIL.send({
      from: {
        email: input.env.EMAIL_FROM_ADDRESS,
        name: input.env.EMAIL_FROM_NAME,
      },
      html: [
        `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; color: #1E293B; background: #FFFFFF; border-radius: 8px; border: 1px solid #E2E8F0;">`,
        `<div style="margin-bottom: 20px;"><strong style="font-size: 20px; color: #0F172A;">Selinow</strong></div>`,
        `<h2 style="font-size: 18px; margin-top: 0; color: #0F172A;">${escapeHtml(subject)}</h2>`,
        `<p style="margin: 16px 0; font-size: 14px; color: #475569;">${escapeHtml(message)}</p>`,
        `<p style="margin: 16px 0 0; font-size: 13px; color: #DC2626;">${escapeHtml(t("auth.email.password_changed_warning"))}</p>`,
        `</div>`,
      ].join(""),
      subject,
      text: [
        subject,
        "",
        message,
        "",
        t("auth.email.password_changed_warning"),
      ].join("\n"),
      to: input.email,
    });
  } catch {
    // Non-blocking for notification
  }
}
