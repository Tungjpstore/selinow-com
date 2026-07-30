export const AUTOMATION_LEVELS = [
  "automatic",
  "approval_required",
  "external_action",
  "unsupported",
] as const;

export type AutomationLevel = typeof AUTOMATION_LEVELS[number];

export const AUTOMATION_TASK_STATUSES = [
  "pending",
  "waiting_user",
  "waiting_provider",
  "running",
  "retryable",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type AutomationTaskStatus = typeof AUTOMATION_TASK_STATUSES[number];

export type AutomationRetryPolicy = {
  baseDelaySeconds: number;
  maxAttempts: number;
  maxDelaySeconds: number;
};

export type AutomationCapabilityDefinition = {
  code: string;
  level: AutomationLevel;
  retryPolicy: AutomationRetryPolicy;
};

export type AutomationTask = {
  actionReference: string | null;
  attemptCount: number;
  auditLogId: string | null;
  capabilityCode: string;
  consentEvidenceReference: string | null;
  createdAt: string;
  id: string;
  inputReference: string;
  idempotencyKeyHash: string;
  lastSafeErrorCode: string | null;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  nextAttemptAt: string | null;
  requestHash: string;
  shopId: string;
  status: AutomationTaskStatus;
  updatedAt: string;
  version: number;
};

export const AUTOMATION_ACTOR_ROLES = ["seller", "operator", "system"] as const;
export type AutomationActorRole = typeof AUTOMATION_ACTOR_ROLES[number];

/** The tenant and actor must travel with every task read or transition. */
export type AutomationAccessContext = {
  actorId: string;
  actorRole: AutomationActorRole;
  shopId: string;
};

/** A scheduler sees only identifiers and state needed to claim work. */
export type AutomationTaskDueReference = {
  id: string;
  shopId: string;
  status: AutomationTaskStatus;
  version: number;
};

export type AutomationExecutionResult =
  | { outcome: "completed" }
  | { outcome: "failed"; safeErrorCode: string }
  | { outcome: "retry"; retryAfterSeconds?: number; safeErrorCode: string };

export type AutomationExecutionReference = {
  attemptCount: number;
  capabilityCode: string;
  inputReference: string;
  shopId: string;
  taskId: string;
};

export type AutomationExecutor = (reference: AutomationExecutionReference) => Promise<AutomationExecutionResult>;

export type AutomationTaskStartInput = {
  actionReference?: string;
  capabilityCode: string;
  idempotencyKeyHash: string;
  inputReference: string;
  requestHash: string;
  shopId: string;
};

export type AutomationContinuation =
  | { evidenceToken: string; kind: "approval_granted" }
  | { evidenceToken: string; kind: "external_action_completed" }
  | { kind: "retry_due" };

export type AutomationContinuationEvidenceResolver = (input: {
  context: AutomationAccessContext;
  evidenceToken: string;
  kind: "approval_granted" | "external_action_completed";
  task: AutomationTask;
}) => Promise<string | null>;

export type AutomationTaskTransitionEvidence = {
  actionReference?: string;
  actorId: string;
  actorRole: AutomationActorRole;
  evidenceReference?: string;
  safeCode?: string;
};

export type AutomationTaskRepository = {
  create(input: { task: AutomationTask; transition: AutomationTaskTransitionEvidence }): Promise<{ created: boolean; task: AutomationTask }>;
  findByIdempotency(input: { idempotencyKeyHash: string; shopId: string }): Promise<AutomationTask | null>;
  get(input: { shopId: string; taskId: string }): Promise<AutomationTask | null>;
  update(input: { expectedVersion: number; shopId: string; task: AutomationTask; transition: AutomationTaskTransitionEvidence }): Promise<AutomationTask | null>;
  claimDue(input: {
    expectedVersion: number;
    leaseExpiresAt: string;
    leaseToken: string;
    now: string;
    shopId: string;
    taskId: string;
    transition: AutomationTaskTransitionEvidence;
  }): Promise<AutomationTask | null>;
  listDue(input: { limit: number; now: string }): Promise<AutomationTaskDueReference[]>;
  recoverExpiredLeases(input: { limit: number; now: string; transition: AutomationTaskTransitionEvidence }): Promise<AutomationTaskDueReference[]>;
};

export type AutomationOrchestrator = {
  cancelTask(
    context: AutomationAccessContext,
    taskId: string,
    expectedVersion: number,
    safeCode?: string,
    actionReference?: string,
  ): Promise<AutomationTask>;
  continueTask(context: AutomationAccessContext, taskId: string, continuation: AutomationContinuation, expectedVersion?: number): Promise<AutomationTask>;
  start(context: AutomationAccessContext, input: AutomationTaskStartInput): Promise<AutomationTask>;
};
