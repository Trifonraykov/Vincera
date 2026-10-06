import { config } from "dotenv"

/**
 * Load `.env.local` then `.env` into process.env, like Next.js does for the app.
 * Values already set in the environment win, so `DATABASE_URL=... pnpm db:migrate` works.
 */
export function loadEnvFiles(): void {
  config({ path: [".env.local", ".env"], quiet: true })
}

/** Read a required variable or exit with a readable message. */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`${name} is not set. Add it to .env.local (see .env.example).`)
    process.exit(1)
  }
  return value
}
