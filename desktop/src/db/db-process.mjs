/**
 * Child process that runs the embedded database: PGlite (Postgres compiled to WebAssembly) with
 * pgvector, stored in the directory given as argv[2], served on 127.0.0.1 for node-postgres.
 *
 * Protocol with the parent (IPC): sends { type: "ready", port } once listening and
 * { type: "error", message } on a startup failure; on { type: "shutdown" } it stops accepting
 * connections, closes the database (flushing it to disk) and exits 0.
 */
import { mkdirSync } from "node:fs"

import { PGlite } from "@electric-sql/pglite"
import { vector } from "@electric-sql/pglite-pgvector"

import { createWireServer } from "./wire-server.mjs"

const dataDir = process.argv[2]
const preferredPort = Number(process.argv[3] ?? 0)
const log = (line) => console.log(line)

let db
let server
let stopping = false

async function main() {
  if (!dataDir) throw new Error("db-process: missing data directory argument")
  mkdirSync(dataDir, { recursive: true })
  db = await PGlite.create({ dataDir, extensions: { vector } })
  // The migrations create the extension too; doing it here keeps a fresh database usable at once.
  await db.exec("CREATE EXTENSION IF NOT EXISTS vector")
  server = createWireServer(db, { log })
  let port
  try {
    port = await server.listen(preferredPort)
  } catch {
    port = await server.listen(0)
  }
  log(`[db] PGlite ${dataDir} listening on 127.0.0.1:${port}`)
  process.send?.({ type: "ready", port })
}

async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  try {
    await server?.close()
    await db?.close()
    log("[db] closed")
  } catch (error) {
    log(`[db] close failed: ${error?.stack ?? error}`)
    code = 1
  }
  process.exit(code)
}

process.on("message", (message) => {
  if (message?.type === "shutdown") void shutdown(0)
})
// The parent went away without asking (crash, kill): still close the database cleanly.
process.on("disconnect", () => void shutdown(0))
process.on("SIGTERM", () => void shutdown(0))
process.on("SIGINT", () => void shutdown(0))

main().catch((error) => {
  log(`[db] failed to start: ${error?.stack ?? error}`)
  process.send?.({ type: "error", message: String(error?.message ?? error) })
  process.exit(1)
})
