// Flat ESLint config for the extension TypeScript sources.
// Correctness-focused: Prettier owns formatting, so no stylistic rules here.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "build.mjs", "eslint.config.js", "**/*.test.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: {
        chrome: "readonly",
        window: "readonly",
        document: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        getComputedStyle: "readonly",
        Node: "readonly",
        NodeFilter: "readonly",
        MutationObserver: "readonly",
      },
    },
    rules: {
      // The first TS pass leans on explicit `any` in DOM helpers; allowed for
      // now, to be tightened incrementally.
      "@typescript-eslint/no-explicit-any": "off",
      // Only require const when EVERY destructured binding is never reassigned,
      // so a mixed `let { a, b } = …` where one member is reassigned is fine.
      "prefer-const": ["error", { destructuring: "all" }],
      // Unused args are fine when prefixed with _ (event handlers, etc.).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  }
);
