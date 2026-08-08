export type PlatformAdminBootstrapFlags = {
  confirm: boolean;
  dryRun: boolean;
  environment: "local" | "production" | "staging";
  json: boolean;
  userEmail: string;
  userId: string;
};

export function parsePlatformAdminBootstrapFlags(argv: string[]): PlatformAdminBootstrapFlags;
export function buildPlatformAdminBootstrapSql(input: { requestId: string; userEmail: string; userId: string }): string;
export function parsePlatformAdminBootstrapOutput(output: string): { adminCount: number; candidateOwnerCount: number; receiptCount: number };
export function runPlatformAdminBootstrap(input: {
  flags: PlatformAdminBootstrapFlags;
  requestId: string;
  runner: (args: string[]) => { stdout: string };
}): { actions: Array<{ code: string; ok: boolean }>; environment: string; ok: boolean };
