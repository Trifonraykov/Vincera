import { defineConfig } from "drizzle-kit"

import { loadEnvFiles } from "./scripts/lib/load-env"

loadEnvFiles()

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/creator_dev",
  },
  strict: true,
  verbose: true,
})
