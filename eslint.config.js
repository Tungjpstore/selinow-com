import eslint from "@eslint/js";
import astro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".astro/**",
      ".wrangler/**",
      "dist/**",
      "docs/frontend-prompt-os/10_AUTOMATION/**/*.ts",
      "docs/frontend-redesign/prompt-os/10_AUTOMATION/**/*.ts",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "worker-configuration.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  ...astro.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      "@typescript-eslint/no-explicit-any": "error"
    },
  },
  {
    files: ["**/*.astro"],
    rules: {
      "no-undef": "off"
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        // Dev-time node scripts may also evaluate code inside a browser page.
        console: "readonly",
        document: "readonly",
        process: "readonly",
        window: "readonly",
      },
    },
  },
);
