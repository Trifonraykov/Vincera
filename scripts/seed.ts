/**
 * pnpm db:seed — demo data (§15): the steps in lib/seed/, run in order against DATABASE_URL.
 * Idempotent (Docker runs it on every start); refuses to run in production.
 */
import { isStrictProductionEnv } from "@/lib/app-env"
import { now } from "@/lib/clock"
import { closeDb } from "@/lib/db/client"
import { runSeed } from "@/lib/seed"

import { parseDatabaseUrl, runScript } from "./lib/db-admin"
import { loadEnvFiles } from "./lib/load-env"
import { connectScriptDatabase } from "./lib/script-db"

loadEnvFiles()

runScript(async () => {
  // APP_ENV decides (Docker and e2e run with NODE_ENV=production but a non-production APP_ENV).
  if (isStrictProductionEnv(process.env)) {
    throw new Error("Refusing to seed demo data: APP_ENV is production.")
  }
  const database = connectScriptDatabase()
  try {
    console.log(`Seeding database "${parseDatabaseUrl(database.url).name}":`)
    await runSeed({ db: database.db, now: now(), log: (line) => console.log(line) })
  } finally {
    await database.close()
    // Steps that call app code may have opened the app's own pool (getDb()).
    await closeDb()
  }
})
