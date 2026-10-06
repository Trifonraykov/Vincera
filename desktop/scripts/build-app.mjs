#!/usr/bin/env node
/**
 * Builds what the desktop app ships next to Electron, in desktop/app-bundle/:
 *
 *   server/         the Next.js standalone server (`output: "standalone"`), with .next/static and
 *                   public/ copied in and every pnpm symlink resolved to a real directory (installers
 *                   for Windows cannot carry symlinks); server.js is patched to run from the
 *                   per-user runtime directory instead of its own (read-only) folder.
 *   server/bootstrap.cjs
 *                   scripts/migrate.ts + lib/seed bundled into one file (desktop/bootstrap).
 *   resources/      files the server reads relative to its working directory: drizzle/ (the
 *                   migrations), lib/agreements/fonts (the agreement PDF), tests/fixtures/social (the
 *                   fake social providers' recorded answers), copied to the runtime directory on
 *                   every start.
 *   icon.png        the app icon (public/icons/icon-512.png).
 *
 * Usage: node scripts/build-app.mjs [--skip-next]   (from desktop/, after `pnpm install` at the root)
 */
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const rootDir = path.resolve(desktopDir, "..")
const outDir = path.join(desktopDir, "app-bundle")
const skipNext = process.argv.includes("--skip-next")

/**
 * Copy a tree, replacing every symlink by a copy of what it points to. pnpm's layout is all
 * symlinks, and the traced copy in standalone/ also holds links whose target was not traced
 * (dangling): those are skipped. A link back into a directory being copied is skipped too, so a
 * cycle cannot recurse forever.
 */
function copyResolved(source, target, ancestors = new Set()) {
  let real
  try {
    real = realpathSync(source)
  } catch {
    return // Dangling link.
  }
  const stats = statSync(real)
  if (stats.isDirectory()) {
    if (ancestors.has(real)) return
    // The build and dev caches are not needed at run time.
    if (/[\\/]\.next[\\/](cache|dev)$/.test(source)) return
    mkdirSync(target, { recursive: true })
    const nested = new Set(ancestors).add(real)
    for (const name of readdirSync(real)) {
      copyResolved(path.join(source, name), path.join(target, name), nested)
    }
  } else if (stats.isFile()) {
    copyFileSync(real, target)
  }
}

function step(message) {
  console.log(`\n> ${message}`)
}

// The agreement PDF's dynamic font lookup makes Turbopack trace the whole project into
// .next/standalone (lib/agreements/pdf.tsx); earlier desktop builds would be copied along.
rmSync(outDir, { recursive: true, force: true })
if (!skipNext) rmSync(path.join(desktopDir, "release"), { recursive: true, force: true })

if (!skipNext) {
  step("Building the Next.js app (standalone output)")
  // NEXT_PUBLIC_* values are inlined at build time, but the server reads NEXT_PUBLIC_APP_URL from
  // its environment at run time (lib/env.ts parses process.env as a whole), and no client code
  // uses it, so the desktop app sets it per launch to the port it actually got. The other values
  // are build-only placeholders that let env validation pass while pages are prerendered (like the
  // Dockerfile); the app gets real ones at run time.
  execFileSync("pnpm", ["build"], {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      NEXT_OUTPUT_STANDALONE: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      APP_ENV: "development",
      FAKE_SERVICES: "all",
      DATABASE_URL: "postgres://build:build@localhost:5432/build",
      AUTH_SECRET: "build-only-placeholder-secret-not-used-at-runtime",
      ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      STRIPE_WEBHOOK_SECRET: "whsec_build_only_placeholder",
    },
  })
}

const standalone = path.join(rootDir, ".next", "standalone")
const standaloneServer = path.join(standalone, "server.js")
if (!existsSync(standaloneServer)) {
  throw new Error(`${standaloneServer} not found: run without --skip-next first.`)
}

step(`Staging the server in ${path.relative(process.cwd(), outDir) || outDir}`)
const serverDir = path.join(outDir, "server")
mkdirSync(serverDir, { recursive: true })

// Only what the server needs. Turbopack traces the whole project into standalone/ (the agreement
// PDF's font lookup is dynamic), so the source folders it copied are left out on purpose.
for (const entry of ["package.json", ".next", "node_modules"]) {
  copyResolved(path.join(standalone, entry), path.join(serverDir, entry))
}
cpSync(path.join(rootDir, ".next", "static"), path.join(serverDir, ".next", "static"), {
  recursive: true,
})
cpSync(path.join(rootDir, "public"), path.join(serverDir, "public"), { recursive: true })

// server.js changes into its own folder, which is read-only inside an installed app. The app keeps
// its files (.data/: the fake services' mailbox, storage, Stripe objects) relative to the working
// directory (lib/services.ts), so the desktop app runs the server from a per-user directory.
const serverJs = readFileSync(standaloneServer, "utf8")
const chdir = "process.chdir(__dirname)"
if (!serverJs.includes(chdir)) throw new Error(`server.js no longer contains ${chdir}`)
writeFileSync(
  path.join(serverDir, "server.js"),
  serverJs.replace(chdir, "process.chdir(process.env.VINCERA_RUNTIME_DIR || __dirname)"),
)

step("Bundling the database bootstrap (migrations + seed)")
await build({
  entryPoints: [path.join(desktopDir, "bootstrap", "bootstrap.ts")],
  outfile: path.join(serverDir, "bootstrap.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  tsconfig: path.join(rootDir, "tsconfig.scripts.json"),
  // From the server's node_modules: `next` (lib/jobs/enqueue.ts imports next/server) and the PDF
  // renderer (pdfkit finds its data files relative to its own module, which bundling breaks).
  external: ["pg-native", "@react-pdf/*"],
  logLevel: "warning",
})

step("Copying run-time resources")
const resourcesDir = path.join(outDir, "resources")
for (const relative of ["drizzle", "lib/agreements/fonts", "tests/fixtures/social"]) {
  cpSync(path.join(rootDir, relative), path.join(resourcesDir, relative), { recursive: true })
}
cpSync(path.join(rootDir, "public", "icons", "icon-512.png"), path.join(outDir, "icon.png"))

console.log("\nDone: desktop/app-bundle is ready for electron-builder.")
