import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${root}` },
      // Mirror Next.js server compilers: `server-only` is a no-op outside client bundles.
      {
        find: /^server-only$/,
        replacement: createRequire(import.meta.url).resolve(
          "next/dist/compiled/server-only/empty.js",
        ),
      },
    ],
  },
  test: {
    // next-auth imports "next/server" without an extension, which Node's ESM resolver rejects
    // (next has no "exports" map); let Vite resolve it instead.
    server: { deps: { inline: ["next-auth"] } },
    passWithNoTests: true,
    restoreMocks: true,
    unstubEnvs: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/global-setup.ts"],
          fileParallelism: true,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
