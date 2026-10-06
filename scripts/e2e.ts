/**
 * pnpm test:e2e [playwright args] — Playwright, in shards under `next dev` (CLAUDE.md §19.36).
 *
 * Under `next dev` one long-lived process compiles every route the suite opens, and Turbopack
 * keeps most of that memory: a whole run (~60 tests) outgrew a 13.4 GB container and the dev
 * server was OOM-killed, failing every later test. Restoring a warm persistent cache
 * (`.next/dev`) made it worse. So without `CI`, a whole-suite run is split into `E2E_DEV_SHARDS`
 * (default 12) Playwright shards run one after another; before each, `.next/dev` is removed, and
 * each shard starts its own dev server (and re-seeds the e2e database in its global setup).
 *
 * With `CI=1` (build + start), `E2E_DEV_SHARDS=1`, spec files, `-g`/`--grep` or an explicit
 * `--shard`, it is one plain `playwright test`. Other arguments pass through. Exits non-zero
 * when any shard fails; every shard runs either way.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const shardCount = Number(process.env.E2E_DEV_SHARDS ?? "12")
// Spec files, a grep or an explicit shard: the caller picked the tests, so run them as asked.
const narrowed = args.some(
  (arg) =>
    /\.ts$|^tests\//.test(arg) ||
    arg.startsWith("--shard") ||
    arg === "-g" ||
    arg.startsWith("--grep"),
)
const sharded = !process.env.CI && !narrowed && Number.isInteger(shardCount) && shardCount > 1

function playwright(extra: readonly string[]): number {
  const result = spawnSync("pnpm", ["exec", "playwright", "test", ...args, ...extra], {
    stdio: "inherit",
    env: process.env,
  })
  return result.status ?? 1
}

/** True when some Next.js dev server is running on this machine (its cache must stay). */
function nextDevRunning(): boolean {
  try {
    const out = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
    return out.split("\n").some((line) => /next-server|next dev/.test(line))
  } catch {
    return true
  }
}

/** Start the next shard's dev server from an empty Turbopack cache (see the header). */
function clearDevCache(): void {
  // The previous shard's server may still be shutting down: give it up to 20 s.
  for (let wait = 0; wait < 40 && nextDevRunning(); wait += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  if (nextDevRunning()) {
    console.log("e2e: a Next.js dev server is running, so .next/dev is kept.")
    return
  }
  rmSync(path.join(process.cwd(), ".next", "dev"), { recursive: true, force: true })
}

if (!sharded) {
  process.exit(playwright([]))
}

const failed: number[] = []
for (let shard = 1; shard <= shardCount; shard += 1) {
  console.log(`\n=== e2e shard ${shard}/${shardCount} (next dev, fresh server and cache) ===\n`)
  clearDevCache()
  if (playwright([`--shard=${shard}/${shardCount}`]) !== 0) failed.push(shard)
}
if (failed.length > 0) {
  console.error(`\ne2e: shard(s) ${failed.join(", ")} of ${shardCount} failed.`)
  process.exit(1)
}
console.log(`\ne2e: all ${shardCount} shards passed.`)
