export class AppError extends Error {
  readonly code: string;
  readonly issues: readonly string[] | undefined;
  readonly status: number;

  constructor(code: string, status: number, issues?: readonly string[]) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
