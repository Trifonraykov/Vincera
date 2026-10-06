/**
 * Vincera desktop: the Creator x Builder platform as a double-click app.
 *
 * On launch it
 *   1. keeps one instance (a second launch focuses the first window);
 *   2. shows a splash screen;
 *   3. loads or creates the per-user secrets (AUTH_SECRET, ENCRYPTION_KEY, a webhook secret) and
 *      settings in the OS app-data folder;
 *   4. starts the embedded database (PGlite + pgvector, src/db/db-process.mjs) unless settings.json
 *      names an external DATABASE_URL (e.g. Supabase);
 *   5. applies the migrations and the idempotent demo seed (server/bootstrap.cjs, the same code
 *      as `pnpm db:migrate` / `pnpm db:seed`);
 *   6. starts the bundled Next.js server on 127.0.0.1 (a fixed port, or a free one when taken)
 *      with every external service fake, like the Docker demo;
 *   7. opens /app. Sign-in emails land in the dev mailbox: menu "Mailbox" (or the floating button
 *      on the sign-in pages) opens it in the window.
 * Quitting stops the server, then closes the database so it is flushed to disk.
 */
import { fork } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { app, BrowserWindow, dialog, Menu, shell } from "electron"

const __dirname = import.meta.dirname

const APP_NAME = "Vincera"
const DEFAULT_PORT = 47321
const DB_DEFAULT_PORT = 47322
// A normal desktop window, so the app shows its desktop layout (sidebar). Below 768 px wide the
// pages switch to the phone layout, so the minimum width stays above that.
const WINDOW_SIZE = { width: 1280, height: 820 }

app.setName(APP_NAME)
// A separate data folder (tests, a second profile): VINCERA_USER_DATA_DIR=/some/folder.
if (process.env.VINCERA_USER_DATA_DIR) app.setPath("userData", process.env.VINCERA_USER_DATA_DIR)

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** What build-app.mjs produced: inside the installed app, or desktop/app-bundle in development. */
const bundleDir = app.isPackaged
  ? path.join(process.resourcesPath, "app-bundle")
  : path.join(__dirname, "..", "app-bundle")
const serverDir = path.join(bundleDir, "server")
const resourcesDir = path.join(bundleDir, "resources")
const iconPath = path.join(bundleDir, "icon.png")

const userDir = app.getPath("userData")
const paths = {
  database: path.join(userDir, "database"),
  runtime: path.join(userDir, "runtime"),
  logs: path.join(userDir, "logs"),
  log: path.join(userDir, "logs", "vincera.log"),
  secrets: path.join(userDir, "secrets.json"),
  settings: path.join(userDir, "settings.json"),
}

// ---------------------------------------------------------------------------------------------
// Logging: every child's output goes to logs/vincera.log (Help → Show logs).
// ---------------------------------------------------------------------------------------------

let logStream = null

function openLog() {
  fs.mkdirSync(paths.logs, { recursive: true })
  try {
    // Start a fresh file when the old one grew past 5 MB; keep the previous one.
    if (fs.statSync(paths.log).size > 5 * 1024 * 1024) {
      fs.renameSync(paths.log, `${paths.log}.1`)
    }
  } catch {
    // No log yet.
  }
  logStream = fs.createWriteStream(paths.log, { flags: "a" })
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`
  logStream?.write(text)
  if (!app.isPackaged) process.stdout.write(text)
}

function pipeOutput(child, label) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    let pending = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) log(`[${label}] ${line}`)
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Secrets and settings
// ---------------------------------------------------------------------------------------------

/** Generated once per user and kept: sessions and encrypted OAuth tokens depend on them. */
function loadSecrets() {
  let secrets = {}
  try {
    secrets = JSON.parse(fs.readFileSync(paths.secrets, "utf8"))
  } catch {
    // First launch.
  }
  const generated = {
    AUTH_SECRET: crypto.randomBytes(32).toString("base64"),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    STRIPE_WEBHOOK_SECRET: `whsec_${crypto.randomBytes(24).toString("hex")}`,
  }
  let changed = false
  for (const [key, value] of Object.entries(generated)) {
    if (typeof secrets[key] !== "string" || secrets[key].length === 0) {
      secrets[key] = value
      changed = true
    }
  }
  if (changed) {
    fs.writeFileSync(paths.secrets, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 })
  }
  return secrets
}

const DEFAULT_SETTINGS = {
  // Empty: the embedded database. A postgres:// URL (e.g. a Supabase project's session pooler)
  // makes the app use that database instead; see desktop/README.md.
  databaseUrl: "",
  // DATABASE_SSL / DATABASE_CA_CERT for that database (lib/db/connection.ts): "" | "disable" |
  // "require" | "verify-full", and the CA certificate as PEM text or a file path.
  databaseSsl: "",
  databaseCaCert: "",
  // Run the demo seed on an external database too (the embedded one is always seeded).
  seedExternalDatabase: false,
  // The app's local port; another one is picked when it is taken.
  port: DEFAULT_PORT,
  // Addresses that get the admin role when they sign up.
  adminEmails: "admin@example.com",
}

function loadSettings() {
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(paths.settings, "utf8"))
  } catch (error) {
    if (fs.existsSync(paths.settings)) {
      throw new Error(`settings.json is not valid JSON (${error.message}). Fix or delete it.`)
    }
  }
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  if (JSON.stringify(merged) !== JSON.stringify(settings)) {
    // Write the full file so every option is visible to edit.
    fs.writeFileSync(paths.settings, `${JSON.stringify(merged, null, 2)}\n`)
  }
  return merged
}

// ---------------------------------------------------------------------------------------------
// Child processes (Electron's own Node: ELECTRON_RUN_AS_NODE)
// ---------------------------------------------------------------------------------------------

const children = new Set()

function startChild(label, modulePath, args, { env = {}, cwd } = {}) {
  const child = fork(modulePath, args, {
    cwd,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  })
  children.add(child)
  child.on("exit", (code, signal) => {
    children.delete(child)
    log(`[${label}] exited (${signal ?? code})`)
  })
  pipeOutput(child, label)
  return child
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

let dbChild = null

function startEmbeddedDatabase() {
  return new Promise((resolve, reject) => {
    dbChild = startChild("db", path.join(__dirname, "db", "db-process.mjs"), [
      paths.database,
      String(DB_DEFAULT_PORT),
    ])
    const onExit = (code) => reject(new Error(`The database stopped while starting (${code}).`))
    dbChild.once("exit", onExit)
    dbChild.on("message", (message) => {
      if (message?.type === "ready") {
        dbChild.off("exit", onExit)
        dbChild.on("exit", (code) => {
          if (!quitting) fail("The database stopped unexpectedly.", code)
        })
        resolve(`postgres://postgres:postgres@127.0.0.1:${message.port}/postgres`)
      } else if (message?.type === "error") {
        reject(new Error(message.message))
      }
    })
  })
}

async function stopEmbeddedDatabase() {
  if (!dbChild) return
  const child = dbChild
  dbChild = null
  if (child.connected) child.send({ type: "shutdown" })
  else child.kill("SIGTERM")
  await waitForExit(child, 15_000)
}

function runBootstrap(env, { seed }) {
  return new Promise((resolve, reject) => {
    const args = [path.join(resourcesDir, "drizzle")]
    if (seed) args.push("--seed")
    const child = startChild("setup", path.join(serverDir, "bootstrap.cjs"), args, {
      env,
      cwd: paths.runtime,
    })
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Preparing the database failed (exit code ${code}).`)),
    )
  })
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

let serverChild = null

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function pickPort(preferred) {
  if (Number.isInteger(preferred) && preferred > 0 && (await isPortFree(preferred))) {
    return preferred
  }
  return freePort()
}

/** The files the server reads relative to its working directory (see build-app.mjs). */
function prepareRuntimeDir() {
  fs.mkdirSync(paths.runtime, { recursive: true })
  for (const relative of [
    "lib/agreements/fonts",
    "tests/fixtures/social",
    "tests/fixtures/appstore",
    "tests/fixtures/web",
  ]) {
    const target = path.join(paths.runtime, relative)
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(path.join(resourcesDir, relative), target, { recursive: true })
  }
}

function httpStatus(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on("error", () => resolve(0))
    request.setTimeout(5_000, () => {
      request.destroy()
      resolve(0)
    })
  })
}

async function waitForServer(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!serverChild) throw new Error("The server stopped while starting.")
    const status = await httpStatus(`${baseUrl}/sign-in`)
    if (status > 0 && status < 500) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error("The server did not start in time.")
}

async function stopServer() {
  if (!serverChild) return
  const child = serverChild
  serverChild = null
  child.kill("SIGTERM")
  await waitForExit(child, 8_000)
}

// ---------------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------------

let mainWindow = null
let baseUrl = null
let quitting = false

function createWindow() {
  mainWindow = new BrowserWindow({
    ...WINDOW_SIZE,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow.once("ready-to-show", () => mainWindow?.show())
  mainWindow.on("closed", () => {
    mainWindow = null
  })
  mainWindow.loadFile(path.join(__dirname, "splash.html"), {
    query: { icon: pathToFileURL(iconPath).href },
  })

  const contents = mainWindow.webContents
  // Links to other sites open in the default browser; the app's own pages stay in the window.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      mainWindow?.loadURL(url)
    } else if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:") || isAppUrl(url)) return
    event.preventDefault()
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })
  const refreshHelper = () => void injectMailboxButton()
  contents.on("did-finish-load", refreshHelper)
  contents.on("did-navigate-in-page", refreshHelper)
}

function isAppUrl(url) {
  if (!baseUrl) return false
  try {
    return new URL(url).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

function setSplashStatus(text) {
  log(`[app] ${text}`)
  const contents = mainWindow?.webContents
  if (!contents || baseUrl) return
  contents
    .executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)})`)
    .catch(() => undefined)
}

function openPath(pathname) {
  if (!mainWindow || !baseUrl) return
  mainWindow.loadURL(new URL(pathname, baseUrl).toString())
}

/**
 * Sign-in emails go to the dev mailbox (the fake email service). On the sign-in pages a small
 * "Open mailbox" button links there, and the mailbox gets a "Back to the app" button.
 */
async function injectMailboxButton() {
  const contents = mainWindow?.webContents
  if (!contents || !baseUrl) return
  const url = contents.getURL()
  if (!isAppUrl(url)) return
  const { pathname } = new URL(url)
  const onMailbox = pathname.startsWith("/api/dev/mailbox")
  const onSignIn = /^\/(sign-in|sign-up)(\/|$)/.test(pathname)
  const target = onMailbox ? "/app" : "/api/dev/mailbox"
  const label = onMailbox ? "← Back to the app" : "Open mailbox ✉"
  const show = onMailbox || onSignIn
  const script = `(() => {
    const id = "vincera-desktop-mailbox"
    let button = document.getElementById(id)
    if (!${show}) { button?.remove(); return }
    if (!button) {
      button = document.createElement("a")
      button.id = id
      button.setAttribute("style", [
        "position:fixed", "z-index:2147483647", "right:16px", "bottom:16px",
        "padding:10px 16px", "border-radius:999px", "font:600 14px system-ui,sans-serif",
        "background:#0a0a0a", "color:#fafafa", "text-decoration:none",
        "box-shadow:0 4px 16px rgba(0,0,0,.25)", "border:1px solid #fafafa33",
      ].join(";"))
      document.body.appendChild(button)
    }
    button.href = ${JSON.stringify(target)}
    button.textContent = ${JSON.stringify(label)}
  })()`
  await contents.executeJavaScript(script).catch(() => undefined)
}

function buildMenu() {
  const isMac = process.platform === "darwin"
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Mailbox",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => openPath("/api/dev/mailbox"),
        },
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => openPath("/app") },
        { type: "separator" },
        { label: "Open Data Folder", click: () => void shell.openPath(userDir) },
        { label: "Open Settings File", click: () => void shell.openPath(paths.settings) },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Back",
          accelerator: isMac ? "Cmd+[" : "Alt+Left",
          click: () => mainWindow?.webContents.navigationHistory.goBack(),
        },
        {
          label: "Forward",
          accelerator: isMac ? "Cmd+]" : "Alt+Right",
          click: () => mainWindow?.webContents.navigationHistory.goForward(),
        },
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Show Logs", click: () => void shell.openPath(paths.log) },
        {
          label: "About the Mailbox",
          click: () =>
            void dialog.showMessageBox({
              type: "info",
              title: "Signing in",
              message: "Sign-in emails arrive in the app's own mailbox.",
              detail:
                "Enter any email address on the sign-in page, then choose File → Open Mailbox " +
                '(or the "Open mailbox" button) and click the sign-in link, or type the code.',
            }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------------------------
// Boot and shutdown
// ---------------------------------------------------------------------------------------------

function fail(message, detail) {
  log(`[app] FAILED: ${message} ${detail ?? ""}`)
  const contents = mainWindow?.webContents
  if (!contents) return
  const hint = `Details are in ${paths.log} (Help → Show Logs).`
  const show = () =>
    contents
      .executeJavaScript(
        `window.setFailed && window.setFailed(${JSON.stringify(message)}, ${JSON.stringify(hint)})`,
      )
      .catch(() => undefined)
  if (baseUrl) {
    baseUrl = null
    mainWindow
      .loadFile(path.join(__dirname, "splash.html"), {
        query: { icon: pathToFileURL(iconPath).href },
      })
      .then(show, show)
  } else {
    void show()
  }
}

async function boot() {
  setSplashStatus("Loading settings…")
  const secrets = loadSecrets()
  const settings = loadSettings()
  prepareRuntimeDir()

  const external = typeof settings.databaseUrl === "string" && settings.databaseUrl.trim() !== ""
  let databaseUrl
  if (external) {
    databaseUrl = settings.databaseUrl.trim()
    setSplashStatus("Connecting to your database…")
  } else {
    setSplashStatus("Starting the database…")
    databaseUrl = await startEmbeddedDatabase()
  }

  const port = await pickPort(Number(settings.port))
  // The server listens on 127.0.0.1, but pages and links use "localhost": Next.js builds request
  // URLs from it, and Auth.js only follows callback URLs on the request's own origin.
  const origin = `http://localhost:${port}`
  const env = {
    NODE_ENV: "production",
    APP_ENV: "development",
    FAKE_SERVICES: "all",
    DEV_MAILBOX: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_APP_URL: origin,
    AUTH_URL: origin,
    AUTH_TRUST_HOST: "true",
    APP_NAME,
    ADMIN_EMAILS: String(settings.adminEmails ?? ""),
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: external ? String(settings.databaseSsl ?? "") : "disable",
    DATABASE_CA_CERT: external ? String(settings.databaseCaCert ?? "") : "",
    // The embedded database serves one transaction at a time; a small pool is plenty.
    DATABASE_POOL_MAX: external ? "" : "4",
    AUTH_SECRET: secrets.AUTH_SECRET,
    ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
    STRIPE_WEBHOOK_SECRET: secrets.STRIPE_WEBHOOK_SECRET,
    VINCERA_RUNTIME_DIR: paths.runtime,
  }

  setSplashStatus(external ? "Updating your database…" : "Preparing the database…")
  await runBootstrap(env, { seed: !external || settings.seedExternalDatabase === true })

  setSplashStatus("Starting Vincera…")
  serverChild = startChild("server", path.join(serverDir, "server.js"), [], {
    env: { ...env, PORT: String(port), HOSTNAME: "127.0.0.1" },
    cwd: paths.runtime,
  })
  serverChild.on("exit", (code) => {
    serverChild = null
    if (!quitting) fail("The app's server stopped unexpectedly.", code)
  })
  await waitForServer(`http://127.0.0.1:${port}`, 120_000)

  baseUrl = origin
  log(`[app] ready at ${origin}`)
  openPath("/app")
}

async function shutdown() {
  log("[app] shutting down")
  await stopServer()
  await stopEmbeddedDatabase()
  for (const child of children) child.kill("SIGKILL")
  logStream?.end()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    openLog()
    log(`[app] ${APP_NAME} ${app.getVersion()} starting (data: ${userDir})`)
    buildMenu()
    createWindow()
    boot().catch((error) => fail(error?.message ?? String(error), error?.stack))
  })

  // The window is the app: closing it quits (also on macOS, so the server never runs unseen).
  app.on("window-all-closed", () => app.quit())

  let shutdownDone = false
  app.on("before-quit", (event) => {
    if (shutdownDone) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    shutdown()
      .catch((error) => log(`[app] shutdown error: ${error?.stack ?? error}`))
      .finally(() => {
        shutdownDone = true
        app.quit()
      })
  })
}
