import { AppError } from "../core/errors";

export type OutboundMessagePolicyInput = {
  conversationWindowExpiresAt?: string | null;
  isSecret: boolean;
  providerCode: string;
  recipientScope: "channel" | "direct" | "group" | "private";
  templateName?: string | null;
  now?: Date;
};

export type OutboundMessagePolicyDecision = {
  requiresTemplate: boolean;
  safeMode: "authorized_reveal" | "normal" | "template";
};

const PROVIDER_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const TEMPLATE_NAME = /^[a-z][a-z0-9_.-]{2,127}$/u;

function requireTimestamp(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AppError("validation_failed", 400, ["conversation_window_invalid"]);
  return parsed;
}

function requireTemplate(value: string | null | undefined): string {
  if (typeof value !== "string" || !TEMPLATE_NAME.test(value)) {
    throw new AppError("channel_template_required", 409);
  }
  return value;
}

/**
 * Enforces provider messaging windows before any provider call. Secrets never
 * travel through generic messaging adapters; buyers use an authorized reveal.
 */
export function decideOutboundMessagePolicy(input: OutboundMessagePolicyInput): OutboundMessagePolicyDecision {
  if (!PROVIDER_CODE.test(input.providerCode)) throw new AppError("validation_failed", 400, ["channel_provider_code_invalid"]);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new AppError("validation_failed", 400, ["message_time_invalid"]);
  if (["whatsapp.cloud", "zalo.mini_app"].includes(input.providerCode) && input.recipientScope === "group") {
    throw new AppError("channel_recipient_scope_invalid", 409);
  }
  if (input.isSecret) {
    if (input.recipientScope !== "direct" && input.recipientScope !== "private") {
      throw new AppError("channel_secret_delivery_forbidden", 409);
    }
    return { requiresTemplate: false, safeMode: "authorized_reveal" };
  }
  if (input.providerCode !== "whatsapp.cloud") return { requiresTemplate: false, safeMode: "normal" };
  const expiresAt = requireTimestamp(input.conversationWindowExpiresAt);
  const windowOpen = expiresAt !== null && expiresAt > now.getTime();
  if (windowOpen) return { requiresTemplate: false, safeMode: "normal" };
  requireTemplate(input.templateName);
  return { requiresTemplate: true, safeMode: "template" };
}
