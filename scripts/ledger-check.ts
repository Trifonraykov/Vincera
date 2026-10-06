/**
 * pnpm ledger:check [--no-stripe] — reconcile the ledger (§9; CLAUDE.md §19.33).
 *
 * For every order, its entries sum to gross minus refunds; every refund and lost chargeback
 * mirrors its amount; every transfer's entries match its amount minus reversals; and, unless
 * `--no-stripe`, every transfer matches Stripe's (the fake store under `.data/fake-stripe/` when
 * Stripe is fake). Prints a report with ids and amounts only; exits 1 on any mismatch.
 */
import { checkLedger, formatLedgerReport } from "@/lib/ledger/check"
import { getStripeGateway } from "@/lib/stripe/gateway"

import { parseDatabaseUrl, runScript } from "./lib/db-admin"
import { loadEnvFiles } from "./lib/load-env"
import { connectScriptDatabase } from "./lib/script-db"

loadEnvFiles()

runScript(async () => {
  const args = process.argv.slice(2)
  const unknown = args.filter((arg) => arg !== "--no-stripe")
  if (unknown.length > 0) throw new Error("Usage: pnpm ledger:check [--no-stripe]")
  const compareWithStripe = !args.includes("--no-stripe")

  const database = connectScriptDatabase()
  try {
    const gateway = compareWithStripe ? getStripeGateway() : undefined
    const report = await checkLedger(database.db, { compareWithStripe, gateway })
    const { name } = parseDatabaseUrl(database.url)
    const stripe = gateway ? `Stripe ${gateway.mode}` : "Stripe not compared"
    console.log(`ledger:check on database "${name}" (${stripe})`)
    console.log(formatLedgerReport(report))
    if (report.mismatches.length > 0) {
      throw new Error(`ledger:check found ${report.mismatches.length} mismatch(es).`)
    }
  } finally {
    await database.close()
  }
})
