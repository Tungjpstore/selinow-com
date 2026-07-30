export function parseFlags(argv: string[]): {
  buildOnly: boolean;
  confirmProduction: boolean;
  dryRun: boolean;
  environment: "local" | "staging" | "production";
  json: boolean;
};

export function parseDeployFlags(argv: string[]): ReturnType<typeof parseFlags> & {
  releaseManifestPath: string | null;
};

export function run(
  command: string,
  args: string[],
  options?: {
    capture?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): { stderr: string; stdout: string };

export function runWrangler(
  args: string[],
  options?: {
    capture?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): { stderr: string; stdout: string };

export function writeOutput(value: Record<string, unknown>, json: boolean): void;
