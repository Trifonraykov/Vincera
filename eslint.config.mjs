import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

// Spec §19.4: business logic reads time from lib/clock.ts so jobs can run with a mocked clock.
const noDirectClock = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: "Use now() from '@/lib/clock' instead of new Date() in business logic.",
    },
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      message: "Use now() from '@/lib/clock' instead of Date.now() in business logic.",
    },
  ],
}

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["lib/**/*.{ts,tsx}", "inngest/**/*.{ts,tsx}"],
    ignores: ["lib/clock.ts"],
    rules: noDirectClock,
  },
  {
    // E2E specs use the `test` from tests/e2e/fixtures.ts (one client IP per test, §19.4).
    files: ["tests/e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@playwright/test",
              importNames: ["test"],
              message:
                "Import `test` from tests/e2e/fixtures.ts (gives each test its own client IP).",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    // Next.js output
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Legacy Vincera Bot (§19.1) — never linted or modified
    "vincera/**",
    "dashboard/**",
    ".claude/**",
    "supabase/**",
    // Generated / tool output
    "drizzle/**",
    "playwright-report/**",
    "test-results/**",
    "coverage/**",
    ".data/**",
    // Desktop app build output (desktop/README.md)
    "desktop/app-bundle/**",
    "desktop/release/**",
  ]),
])
