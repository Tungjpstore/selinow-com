import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

const authenticatedBrowserWranglerConfig = process.env.SELINOW_AUTH_BROWSER_WRANGLER_CONFIG;
const authenticatedBrowserFileSystemAllow = authenticatedBrowserWranglerConfig
  ? [resolve("."), realpathSync(resolve("node_modules"))]
  : undefined;

export default defineConfig({
  adapter: cloudflare({
    ...(authenticatedBrowserWranglerConfig
      ? { configPath: authenticatedBrowserWranglerConfig, remoteBindings: false }
      : {}),
    imageService: "compile",
    // Authenticated local browser gates use a disposable D1/KV state directory.
    // Keep the normal Wrangler state path when no gate-specific path is provided.
    persistState: process.env.SELINOW_LOCAL_STATE_DIR
      ? { path: process.env.SELINOW_LOCAL_STATE_DIR }
      : true,
  }),
  devToolbar: { enabled: false },
  output: "server",
  security: {
    checkOrigin: true,
  },
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
    ...(authenticatedBrowserFileSystemAllow
      ? {
          server: {
            fs: {
              allow: authenticatedBrowserFileSystemAllow,
            },
          },
        }
      : {}),
  },
});
