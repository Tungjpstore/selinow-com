export declare const publicBrowserOrigins: Readonly<{
  api: "api.localhost";
  dashboard: "app.localhost";
  marketing: "localhost";
  storefront: "signal.localhost";
}>;

export declare function localPublicOrigins(port?: string): {
  api: string;
  dashboard: string;
  marketing: string;
  storefront: string;
};

export declare function validateLocalPublicBrowserBaseUrl(value: string): string;
export declare function validatePublicPlaywrightArguments(args: string[]): string[];

export declare function buildLocalPublicCommandEnvironment(input: {
  baseUrl: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  stateDirectory: string;
  wranglerConfigPath: string;
}): NodeJS.ProcessEnv;

export declare function assertIsolatedWranglerSecrets(
  configPath: string,
  expectedSecrets: Record<string, string>,
): void;

export declare function assertOwnedDevServerStart(output: string, expectedPort?: string): void;

export declare function writeIsolatedDevVars(
  stateDirectory: string,
  secretFactory: () => string,
): { devVarsPath: string; secrets: Record<string, string> };

export declare function writeIsolatedWranglerConfig(
  repositoryRoot: string,
  stateDirectory: string,
  baseUrl: string,
): string;
