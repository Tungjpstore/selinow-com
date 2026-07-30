export type LogLevel = "debug" | "error" | "info" | "warn";

export type SafeLogEvent = {
  durationMs?: number;
  errorCode?: string;
  event: string;
  metrics?: Readonly<Record<string, boolean | number>>;
  queue?: string;
  requestId?: string;
  schedule?: string;
  scheduledTime?: number;
  source?: "http" | "queue" | "scheduled";
  status?: number;
};

type LogConfiguration = {
  LOG_LEVEL?: unknown;
};

type LogSink = (level: LogLevel, serialized: string) => void;

type LoggerOptions = {
  level?: unknown;
  now?: () => Date;
  sink?: LogSink;
};

const LEVEL_PRIORITY: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const SAFE_CODE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_EVENT = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const SAFE_QUEUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const SAFE_SCHEDULE = /^[0-9*/?, -]{1,80}$/u;
const SAFE_METRIC_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u;
const SENSITIVE_KEY = /(account|authorization|chat|checkout|cookie|credential|customer|email|key|password|qr|recipient|secret|signature|token|webhook)/iu;

function parseLevel(value: unknown): LogLevel | "silent" {
  if (typeof value !== "string") return "info";
  const normalized = value.trim().toLowerCase();
  if (normalized === "off") return "silent";
  return normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error" || normalized === "silent"
    ? normalized
    : "info";
}

function safeInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(maximum, Math.round(value))
    : undefined;
}

function safeMetrics(value: SafeLogEvent["metrics"]): Record<string, boolean | number> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value)
    .filter(([key, metric]) => SAFE_METRIC_KEY.test(key) && !SENSITIVE_KEY.test(key) && (typeof metric === "boolean" || (typeof metric === "number" && Number.isFinite(metric))))
    .slice(0, 64)
    .map(([key, metric]) => [key, typeof metric === "number" ? Math.round(metric) : metric] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function sanitizeLogEvent(input: SafeLogEvent, level: LogLevel, timestamp: string): Record<string, unknown> {
  const output: Record<string, unknown> = {
    event: SAFE_EVENT.test(input.event) ? input.event : "invalid_event",
    level,
    timestamp,
  };
  if (input.source === "http" || input.source === "queue" || input.source === "scheduled") output.source = input.source;
  if (typeof input.requestId === "string" && SAFE_REQUEST_ID.test(input.requestId)) output.requestId = input.requestId;
  if (typeof input.errorCode === "string" && SAFE_CODE.test(input.errorCode)) output.errorCode = input.errorCode;
  if (typeof input.queue === "string" && SAFE_QUEUE.test(input.queue)) output.queue = input.queue;
  if (typeof input.schedule === "string" && SAFE_SCHEDULE.test(input.schedule)) output.schedule = input.schedule;
  const status = safeInteger(input.status, 599);
  if (status !== undefined) output.status = status;
  const durationMs = safeInteger(input.durationMs, 86_400_000);
  if (durationMs !== undefined) output.durationMs = durationMs;
  const scheduledTime = safeInteger(input.scheduledTime, 8_640_000_000_000_000);
  if (scheduledTime !== undefined) output.scheduledTime = scheduledTime;
  const metrics = safeMetrics(input.metrics);
  if (metrics !== undefined) output.metrics = metrics;
  return output;
}

function defaultSink(level: LogLevel, serialized: string): void {
  if (level === "debug") console.debug(serialized);
  else if (level === "info") console.info(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.error(serialized);
}

export function createLogger(options: LoggerOptions = {}) {
  const threshold = parseLevel(options.level);
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? defaultSink;
  const write = (level: LogLevel, event: SafeLogEvent): void => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[threshold]) return;
    try {
      sink(level, JSON.stringify(sanitizeLogEvent(event, level, now().toISOString())));
    } catch {
      // Logging must never change request, queue, or scheduled task behavior.
    }
  };
  return {
    debug: (event: SafeLogEvent) => { write("debug", event); },
    error: (event: SafeLogEvent) => { write("error", event); },
    info: (event: SafeLogEvent) => { write("info", event); },
    warn: (event: SafeLogEvent) => { write("warn", event); },
  };
}

export function loggerFor(env: LogConfiguration) {
  return createLogger({ level: env.LOG_LEVEL });
}
