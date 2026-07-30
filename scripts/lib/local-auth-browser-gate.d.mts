export declare const localBrowserSecretNames: string[];

export declare function resolveLocalBrowserPort(value?: string): string;
export declare function localBrowserBaseUrl(port: string): string;
export declare function validateLocalBrowserBaseUrl(value: string): string;

export declare function buildIsolatedWranglerConfig(
  sourceConfig: Record<string, unknown>,
  repositoryRoot: string,
  baseUrl: string,
): Record<string, unknown>;

export declare function writeIsolatedWranglerConfig(
  repositoryRoot: string,
  stateDirectory: string,
  baseUrl: string,
): string;

export declare function writeIsolatedDevVars(
  stateDirectory: string,
  secretFactory: () => string,
): { devVarsPath: string; secrets: Record<string, string> };

export declare function assertIsolatedWranglerSecrets(
  configPath: string,
  expectedSecrets: Record<string, string>,
): void;

export declare function buildLocalCommandEnvironment(input: {
  baseUrl: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  stateDirectory: string;
  wranglerConfigPath: string;
}): NodeJS.ProcessEnv;

export declare function validatePlaywrightArguments(args: string[]): string[];
export declare function assertOwnedDevServerStart(output: string, expectedPort?: string): void;
