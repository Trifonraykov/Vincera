/**
 * pnpm matching:train — train matching v1 (§8 Phase 7; CLAUDE.md §19.38, §19.42).
 *
 * Fits the logistic models on v0's shown matches and their outcomes, evaluates them against v0 on
 * the held-out split, and stores an **inactive** `matching_config` row `v1-<YYYY-MM-DD>`.
 * Activate it on /admin/matching. Prints counts and metrics only; exits 1 when there is too
 * little history to train.
 */
import { trainMatchingModel } from "@/lib/matching/v1/train"

import { parseDatabaseUrl, runScript } from "./lib/db-admin"
import { loadEnvFiles } from "./lib/load-env"
import { connectScriptDatabase } from "./lib/script-db"

loadEnvFiles()

function format(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(4)
}

runScript(async () => {
  if (process.argv.length > 2) throw new Error("Usage: pnpm matching:train")
  const database = connectScriptDatabase()
  try {
    const { name } = parseDatabaseUrl(database.url)
    console.log(`matching:train on database "${name}"`)
    const trained = await trainMatchingModel(database.db, { requestedByUserId: null })
    const { metrics } = trained
    console.log(`  stored ${trained.modelVersion} (inactive)`)
    console.log(
      `  rows: ${metrics.rows.training} training, ${metrics.rows.holdout} held out, ${metrics.rows.excludedPositives} positives excluded`,
    )
    for (const target of ["accepted", "sale"] as const) {
      const entry = metrics.targets[target]
      console.log(
        `  ${target}: AUC v1 ${format(entry.v1?.auc)} vs v0 ${format(entry.v0.auc)}; log loss v1 ${format(entry.v1?.logLoss)} vs v0 ${format(entry.v0.logLoss)}${entry.reason ? ` (${entry.reason})` : ""}`,
      )
    }
  } finally {
    await database.close()
  }
})
