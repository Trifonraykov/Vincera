# Desktop app

Vincera as an app you double-click: the whole platform (the Next.js app in the repository root) with its own database inside, no Docker, terminal or Postgres needed. Every external service (email, Stripe, social networks, AI) runs fake, like the Docker demo, so it is for trying the product, not for real money or real creators.

## Install

Download the installer for your computer from the repository's **Releases** page (prereleases named `desktop-<commit>`), or from the artifacts of the latest **Desktop app** workflow run under **Actions**.

| Computer | File | First launch |
|---|---|---|
| macOS (Apple silicon) | `Vincera-<version>-mac-arm64.dmg` (or the `.zip`) | Open the `.dmg` and drag **Vincera** to **Applications**. The app is not signed with an Apple Developer ID, so the first time **right-click** (or Control-click) Vincera in Applications and choose **Open**, then **Open** again. On macOS 15 and later, if there is no Open button: try to open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**. If macOS says the app "is damaged", run `xattr -cr /Applications/Vincera.app` in Terminal once. |
| Windows 10/11 | `Vincera-<version>-win-x64.exe` | Run the installer. SmartScreen warns about an unknown publisher (the installer is not signed): click **More info → Run anyway**. It installs for your user only and adds a Start menu entry. |
| Linux (x64) | `Vincera-<version>-linux-x86_64.AppImage` | Make it executable (`chmod +x`, or Properties → Allow executing) and double-click it. If it does not start, install `libfuse2` (Ubuntu: `sudo apt install libfuse2t64`). |

## Use

1. Launch Vincera. The first start takes about half a minute (it creates the database and fills it with demo data); later starts take a few seconds.
2. The app opens on the sign-in page. Enter any email address (it does not need to exist) and ask for a sign-in link.
3. Emails never leave your computer: they land in the app's own **mailbox**. Click the **Open mailbox** button at the bottom of the sign-in page, or choose **File → Open Mailbox** (Ctrl+Shift+M / Cmd+Shift+M), then click the sign-in link (or type the code shown in the email). **← Back to the app** returns to the app.
4. Sign up as `admin@example.com` to get the admin area. The demo data includes 10 creators (`seed-creator-01@example.com` … `-10`) and 10 builders (`seed-builder-01@example.com` … `-10`) you can sign in as.

The window starts phone-sized (the app is mobile-first); resize it freely. **File → Home** goes back to the app; **View** has back/forward, reload and zoom. Closing the window quits the app.

## Where your data lives

Everything is in the app-data folder (**File → Open Data Folder**):

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/Vincera` |
| Windows | `%APPDATA%\Vincera` |
| Linux | `~/.config/Vincera` |

- `database/`: the embedded Postgres database.
- `secrets.json`: `AUTH_SECRET`, `ENCRYPTION_KEY` and a webhook secret, generated on the first launch and kept (sessions and stored tokens depend on them). Do not share it.
- `settings.json`: options (below).
- `runtime/.data/`: the fake services' files (mailbox, uploads, fake Stripe objects).
- `logs/vincera.log`: what the app, the database and the server printed (**Help → Show Logs**).

To start over, quit Vincera and delete the folder. Uninstalling the app keeps it.

## Settings (`settings.json`)

Written on the first launch with every option; edit it while the app is closed (**File → Open Settings File**).

| Key | Default | Meaning |
|---|---|---|
| `databaseUrl` | `""` | Empty: the embedded database. A `postgres://` URL: use that database instead, for example a Supabase project (below). |
| `databaseSsl` | `""` | `DATABASE_SSL` for that database: `disable`, `require` or `verify-full` (empty: from the URL; `require` for Supabase hosts). |
| `databaseCaCert` | `""` | `DATABASE_CA_CERT`: the server's CA certificate as PEM text or a file path (needed for `verify-full` on Supabase). |
| `seedExternalDatabase` | `false` | Also fill an external database with the demo data (the embedded one always is). |
| `port` | `47321` | The local port of the app's server. When it is taken, another free one is used. |
| `adminEmails` | `admin@example.com` | Comma-separated addresses that become admins when they sign up. |

### Using a Supabase database

Put the project's **session pooler** connection string (Supabase dashboard → **Connect**) in `databaseUrl`, for example:

```json
{
  "databaseUrl": "postgresql://postgres.abcdefghijklmnop:YOUR-PASSWORD@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
  "databaseSsl": "require"
}
```

On the next launch the app migrates that database (and applies the Supabase hardening) instead of starting its own. The project must belong to the platform alone: the migrations refuse a database that holds another app's tables (see the root README, "Database on Supabase", and [`docs/supabase.md`](../docs/supabase.md)). OAuth tokens are encrypted with the `ENCRYPTION_KEY` in `secrets.json`, so if another copy of the platform (Docker, `pnpm dev`) uses the same project, give both the same key. Clear `databaseUrl` to go back to the embedded database (its data is still there).

## How it works

- **Electron** (`src/main.mjs`) shows a splash screen, keeps a single instance, and runs three Node processes with Electron's own Node (`ELECTRON_RUN_AS_NODE`), so nothing has to be installed:
  - **The database** (`src/db/db-process.mjs`): [PGlite](https://pglite.dev) (Postgres 17 compiled to WebAssembly) with the pgvector extension, stored in `database/`, served on `127.0.0.1` by `src/db/wire-server.mjs` so the app's driver (node-postgres) connects to it like to any Postgres. PGlite is a single Postgres session, so the server gives one client the session from its first message until Postgres reports it idle (no transaction, no half-sent query), and queues the others: transaction pooling, which the platform already supports for Supabase's pooler. `@electric-sql/pglite-socket` was tried first; its multiplexer switches clients between individual protocol messages, so two connections' queries could interleave, and it is not used.
  - **The setup** (`server/bootstrap.cjs`): the repository's own migration and seed code (`scripts/lib/db-admin.ts` `runMigrations`, `lib/seed`) bundled into one file. It runs on every start; both are idempotent.
  - **The server**: the Next.js `output: "standalone"` build, on `127.0.0.1` with a fixed port (or a free one), started with `APP_ENV=development`, `FAKE_SERVICES=all`, `DEV_MAILBOX=1` and `NEXT_PUBLIC_APP_URL` / `AUTH_URL` set to `http://localhost:<port>`. The server reads `NEXT_PUBLIC_APP_URL` at run time (`lib/env.ts` parses `process.env`), and no browser code uses it, so the port can change between launches. Its working directory is `runtime/` (the fake services keep their files under `./.data`), where the agreement fonts and the fake social fixtures are copied on each start.
- Quitting stops the server, then asks the database to close (flushing it to disk) before the app exits.
- Links to other sites open in your browser; the app's own pages stay in the window.

## Build it yourself

From the repository root, with Node.js 22+ and pnpm:

```bash
pnpm install --frozen-lockfile --config.node-linker=hoisted   # a flat node_modules (see below)
cd desktop
npm ci
npm run build:app      # Next.js standalone build + bootstrap bundle → desktop/app-bundle/
npm start              # run it from source (Electron)
npx electron-builder --linux AppImage   # or: --mac dmg zip, --win nsis → desktop/release/
```

`node-linker=hoisted` matters: the standalone server copies `node_modules` as the install laid it out, and pnpm's default layout is made of symlinks, which installers (Windows in particular) cannot carry. `npm run build:app -- --skip-next` reuses an existing `.next/standalone` build.

Check a build: `APPIMAGE_EXTRACT_AND_RUN=1 xvfb-run -a node scripts/smoke-test.mjs --app release/Vincera-<version>-linux-x86_64.AppImage` (or without `--app` for the source; prefer the AppImage, which runs from outside the checkout, over `release/linux-unpacked`, where a module missing from the bundle would still be found in the repository's `node_modules`) launches the app with an empty data folder, waits for the sign-in page, signs up through the in-app mailbox, picks a role, quits, launches again and checks the user is still signed in and the seed did not run twice. Screenshots go to `release/smoke/`. `VINCERA_USER_DATA_DIR=<folder>` makes any launch use another data folder.

The **Desktop app** workflow (`.github/workflows/desktop.yml`) does this on every push to `claude/youthful-gauss-hvgurg` and on manual runs: it builds the macOS (arm64 `.dmg` + `.zip`), Windows (x64 NSIS `.exe`) and Linux (x64 `.AppImage`) installers, runs the smoke test on Linux, uploads the installers as workflow artifacts and publishes them on a prerelease tagged `desktop-<short sha>`.

## Limitations

- Unsigned installers: macOS Gatekeeper and Windows SmartScreen warn on the first launch (see Install). Signing needs an Apple Developer ID and a Windows code-signing certificate (electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD`, plus notarization on macOS).
- macOS builds are Apple silicon only (`macos-latest` runners are arm64); an Intel build needs an `x64` job on an Intel runner.
- No auto-update: install a newer build over the old one (the data folder is kept).
- The embedded database runs one transaction at a time. That is plenty for one person, but it is not a server for a team; point `databaseUrl` at a hosted Postgres for that.
- Everything external is fake (§19.3 of `CLAUDE.md`): no real emails, payments or social data.
- On Windows, the installation and the app-data folder must be on the same drive (the server resolves its own folder relative to its working directory).
