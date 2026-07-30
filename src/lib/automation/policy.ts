import { AppError } from "../core/errors";
import { AUTOMATION_ACTOR_ROLES } from "./types";
import type { AutomationAccessContext, AutomationCapabilityDefinition, AutomationLevel, AutomationRetryPolicy, AutomationTaskStartInput, AutomationTaskTransitionEvidence } from "./types";

export const DEFAULT_AUTOMATION_RETRY_POLICY: AutomationRetryPolicy = {
  baseDelaySeconds: 30,
  maxAttempts: 5,
  maxDelaySeconds: 3_600,
};

const CAPABILITY_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// References identify a Selinow-owned record; they are not provider URLs,
// OAuth state, tokens or arbitrary callback payloads. The resource kind and
// opaque record ID are resolved server-side after tenant authorization.
const SAFE_REFERENCE = /^(?:d1|r2|audit|action):[a-z][a-z0-9._-]{1,63}\/[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const SAFE_CODE = /^[a-z][a-z0-9._:-]{2,95}$/u;
const OPAQUE_EVIDENCE_TOKEN = /^[A-Za-z0-9_-]{16,256}$/u;
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;

export function assertAutomationReference(reference: string): void {
  if (reference.length > 256 || !SAFE_REFERENCE.test(reference)) {
    throw new AppError("automation_reference_invalid", 400);
  }
}

export function assertAutomationEvidenceToken(token: string): void {
  if (!OPAQUE_EVIDENCE_TOKEN.test(token)) {
    throw new AppError("automation_evidence_token_invalid", 400);
  }
}

export function assertAutomationAccessContext(context: AutomationAccessContext): void {
  if (!SAFE_IDENTIFIER.test(context.shopId) || !SAFE_IDENTIFIER.test(context.actorId)) {
    throw new AppError("automation_context_invalid", 400);
  }
  if (!AUTOMATION_ACTOR_ROLES.includes(context.actorRole)) {
    throw new AppError("automation_context_invalid", 400);
  }
}

export function assertAutomationTaskStartInput(input: AutomationTaskStartInput): void {
  if (!SAFE_IDENTIFIER.test(input.shopId) || !CAPABILITY_CODE.test(input.capabilityCode)) {
    throw new AppError("automation_input_invalid", 400);
  }
  if (!SHA256_DIGEST.test(input.idempotencyKeyHash) || !SHA256_DIGEST.test(input.requestHash)) {
    throw new AppError("automation_digest_invalid", 400);
  }
  assertAutomationReference(input.inputReference);
  if (input.actionReference !== undefined) assertAutomationReference(input.actionReference);
}

export function assertAutomationTaskId(taskId: string): void {
  if (!SAFE_IDENTIFIER.test(taskId)) throw new AppError("automation_task_id_invalid", 400);
}

export function assertAutomationTransitionEvidence(transition: AutomationTaskTransitionEvidence): void {
  assertAutomationAccessContext({ actorId: transition.actorId, actorRole: transition.actorRole, shopId: "system" });
  if (transition.safeCode !== undefined && !SAFE_CODE.test(transition.safeCode)) {
    throw new AppError("automation_transition_invalid", 400);
  }
  if (transition.evidenceReference !== undefined) assertAutomationReference(transition.evidenceReference);
  if (transition.actionReference !== undefined) assertAutomationReference(transition.actionReference);
}

export function assertCapabilityDefinition(definition: AutomationCapabilityDefinition): void {
  if (!CAPABILITY_CODE.test(definition.code)) throw new AppError("automation_registry_invalid", 500, ["capability_code_invalid"]);
  if (!Number.isSafeInteger(definition.retryPolicy.baseDelaySeconds) || definition.retryPolicy.baseDelaySeconds < 1) {
    throw new AppError("automation_registry_invalid", 500, ["retry_base_delay_invalid"]);
  }
  if (!Number.isSafeInteger(definition.retryPolicy.maxAttempts) || definition.retryPolicy.maxAttempts < 1) {
    throw new AppError("automation_registry_invalid", 500, ["retry_max_attempts_invalid"]);
  }
  if (!Number.isSafeInteger(definition.retryPolicy.maxDelaySeconds) || definition.retryPolicy.maxDelaySeconds < definition.retryPolicy.baseDelaySeconds) {
    throw new AppError("automation_registry_invalid", 500, ["retry_max_delay_invalid"]);
  }
}

export function initialTaskStatus(level: AutomationLevel): "pending" | "canceled" | "waiting_user" | "waiting_provider" {
  if (level === "approval_required") return "waiting_user";
  if (level === "external_action") return "waiting_provider";
  if (level === "unsupported") return "canceled";
  return "pending";
}

export function nextRetryAt(input: {
  attemptCount: number;
  now: Date;
  policy: AutomationRetryPolicy;
  retryAfterSeconds?: number;
}): string {
  const exponentialDelay = input.policy.baseDelaySeconds * 2 ** Math.max(input.attemptCount - 1, 0);
  const providerDelay = input.retryAfterSeconds !== undefined
    && Number.isSafeInteger(input.retryAfterSeconds)
    && input.retryAfterSeconds > 0
    ? input.retryAfterSeconds
    : 0;
  const delay = Math.min(input.policy.maxDelaySeconds, Math.max(exponentialDelay, providerDelay));
  return new Date(input.now.getTime() + delay * 1_000).toISOString();
}

export function isRetryDue(taskStatus: string, nextAttemptAt: string | null, now: Date): boolean {
  return taskStatus === "retryable" && nextAttemptAt !== null && nextAttemptAt <= now.toISOString();
}
