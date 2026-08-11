export type TriggerCheck = { code: string; detail: string; ok: boolean };
export type TriggerContract = {
  accountId: string;
  consumers: Array<{ queue: string; script: string; settings: Record<string, number | string> }>;
  environment: "staging" | "production";
  schedules: string[];
  workerName: string;
};
export type TriggerInventory = {
  accountId: string;
  environment: "staging" | "production";
  observedAt: string;
  queueConsumers: Array<{ queueName: string; consumers: unknown[] }>;
  schedules: unknown[];
  workerName: string;
};
export type TriggerRunner = (args: string[], options?: { cwd?: string; env?: Record<string, string> }) => { stdout: string; stderr?: string };
export function deriveTriggerInventoryContract(input: { environment: string; spec: unknown; wranglerConfig: unknown }): TriggerContract;
export function auditTriggerInventory(input: { contract: TriggerContract; queueConsumers: unknown[]; schedules: unknown[] }): { checks: TriggerCheck[]; ok: boolean };
export function triggerSchedulePath(contract: TriggerContract): string;
export function discoverTriggerInventory(input: { contract: TriggerContract; token: string; runWranglerImplementation?: TriggerRunner; fetchImplementation?: typeof fetch; now?: Date }): Promise<TriggerInventory>;
export function loadTriggerContract(environment: "staging" | "production", root?: string): Promise<TriggerContract>;
