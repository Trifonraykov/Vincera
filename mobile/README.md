# Vincera for iPhone

A native iOS app for the Creator × Builder platform: React Native with Expo (SDK 57) and Expo Router. It is **not** a website in a wrapper: no WebView, no PWA. Screens are native views, the tab bar is UIKit's (`UITabBarController` via Expo Router's native tabs), navigation is native stacks with large titles, the counter-offer, proposal, new task and idea/product editor open as native form sheets, icons are SF Symbols, actions give haptic feedback, and the session token lives in the iOS Keychain.

The app talks to the platform's JSON API at `/api/mobile/v1/*` (`lib/mobile-api/` and `app/api/mobile/v1/` at the repo root). Both sides share one Zod contract, `lib/mobile-api/schemas.ts`, imported here as `@shared/schemas` (see `metro.config.js` and `tsconfig.json`). Every endpoint calls the same services, authorization rules and events as the web app; the design is in `CLAUDE.md` §19.44.

## What's in it

| Tab | Screens |
|---|---|
| Home | What needs your answer, active collabs, top matches, links to your ideas/products, proposals, audience and earnings |
| Discover | Ranked matches with the plain-language explanation, "Why this match" (the seven features), Save, Dismiss, Send a proposal; Briefs and Saved |
| Collabs | Your collabs; a collab's overview, tasks (complete, reorder, delete, new task sheet) and agreement (read the exact text, sign by typing your full name) |
| Inbox | Conversations (proposal and collab threads, text messages), notifications |
| Me | Role switch, ideas or products (create, edit, publish, archive), proposals, audience, earnings, profile editing, sign out |

Proposal detail has Accept, Counter-offer (sheet), Decline and Withdraw. Things that stay on the web (opened in Safari from the app): onboarding, connecting social accounts, Stripe payouts, notification settings, account deletion, launches and checkout, file attachments.

## Run it in the iOS Simulator (on a Mac)

You need Xcode (with an iOS Simulator runtime), Node 22 and, for the backend, the repo's usual setup (`pnpm install`, Postgres; see the root README).

1. Start the backend from the repo root with fake services, so sign-in codes go to the dev mailbox:

   ```sh
   pnpm db:reset && pnpm db:seed   # first time: demo people, ideas, matches and collabs
   pnpm dev                        # http://localhost:3000 (FAKE_SERVICES=all and DEV_MAILBOX=1 in .env.local)
   ```

2. In another terminal:

   ```sh
   cd mobile
   npm install
   npx expo run:ios                # builds the native app and opens it in the Simulator
   ```

   `npx expo run:ios` runs `expo prebuild` (generates `ios/`, which is not committed) and Xcode. After that, `npm start` and pressing `i` is enough while you only change JavaScript.

3. Sign in: type an email (a seeded one such as `seed-creator-01@example.com` or `seed-builder-01@example.com`, or any new address to sign up), tap **Email me a code**, then open the dev mailbox (the app has a button for it in development builds, or go to <http://localhost:3000/api/dev/mailbox>) and type the 8-character code. New accounts finish onboarding on the web first; the app links there.

The Simulator shares the Mac's `localhost`, so the default API URL works there. A real iPhone needs the Mac's address or a hosted backend (below).

## Point it at a hosted backend

The API URL is baked into the JavaScript bundle at build time:

```sh
EXPO_PUBLIC_API_URL=https://vincera.example.com npx expo run:ios
```

Use https for anything but `localhost` (App Transport Security; local network addresses are allowed for development). The backend must run this repo's code (the `/api/mobile/v1` routes and migration `0011_mobile_api_sessions`).

## Checks

```sh
npm run typecheck     # tsc --noEmit (strict), including the shared contract
npm run lint          # expo lint
npm run export:ios    # compiles the iOS JavaScript bundle (Hermes) without Xcode
```

GitHub Actions (`.github/workflows/ios.yml`) runs these on macOS, then `expo prebuild` and `xcodebuild` for the iOS Simulator (unsigned), and uploads the `.app` plus Simulator screenshots as workflow artifacts. Set the repository variable `MOBILE_API_URL` to bake a hosted backend into that build.

To install the CI-built app on your own Simulator: download the `Vincera-simulator-app` artifact, unzip it, and run `xcrun simctl install booted Vincera.app` (with a Simulator open).

## TestFlight from your Mac (Xcode + your Apple developer account)

1. In App Store Connect → My Apps → **+** → New App, create the app with bundle id `com.vincera.app` (or your own, then pass `VINCERA_BUNDLE_ID`). Make sure Xcode → Settings → Accounts is signed in to the same Apple account.
2. From the repo: `cd mobile && APPLE_TEAM_ID=<your Team ID> ./scripts/testflight.sh` (Team ID: developer.apple.com/account → Membership details). Needs Node 22+ and CocoaPods (`brew install cocoapods`).
3. The script generates the Xcode project, archives a Release build with automatic signing (`-allowProvisioningUpdates`) and uploads it. After Apple's processing it appears under TestFlight; add yourself as an internal tester and install it from the TestFlight app.

**Server:** the app needs a Vincera server the phone can reach. The sign-in screen has a **Server** field (remembered on the phone), so one build works with any server. To use the desktop app: run it on the Mac, then `cloudflared tunnel --url http://localhost:47321` (`brew install cloudflared`) and type the `https://….trycloudflare.com` address into the Server field. Sign-in codes land in the desktop app's mailbox ("Open the test server's mailbox" on the code screen). Outside production the mobile API builds links and image URLs from the address the phone used, so tunnels work.

## TestFlight from CI (not set up yet)

Nothing here holds Apple credentials. To ship to TestFlight you need an Apple Developer Program membership and an app record in App Store Connect with the bundle id `com.vincera.app`.

**With EAS Build (recommended, no Mac needed):**

1. `npm install -g eas-cli`, then `eas login` and `eas init` in `mobile/` (adds the project id to `app.json`).
2. Replace `https://REPLACE-WITH-YOUR-BACKEND` in `eas.json` with the backend's URL.
3. `eas build --platform ios --profile production`: EAS asks for your Apple ID once and manages the signing certificate and provisioning profile.
4. `eas submit --platform ios --profile production` uploads the build to App Store Connect; it appears in TestFlight after Apple's processing.

To do this from GitHub Actions instead, add a job that runs `eas build --platform ios --profile production --non-interactive --auto-submit`, with these repository secrets (you create them; none exist yet):

- `EXPO_TOKEN`: an access token from expo.dev (Account settings → Access tokens).
- An App Store Connect API key for `eas submit`: `ASC_API_KEY_ID`, `ASC_API_KEY_ISSUER_ID` and the `.p8` key contents (`ASC_API_KEY_P8`), from App Store Connect → Users and Access → Integrations → App Store Connect API (role: App Manager). Reference them in `eas.json` under `submit.production.ios` (`ascApiKeyId`, `ascApiKeyIssuerId`, `ascApiKeyPath`) or let EAS store them with `eas credentials`.

**With fastlane (on your own Mac or a macOS runner):** `expo prebuild --platform ios`, then a `Fastfile` lane using `match` (certificates in a private git repo: secrets `MATCH_GIT_URL`, `MATCH_PASSWORD`), `build_app` (scheme `Vincera`) and `upload_to_testflight` with the same App Store Connect API key (`app_store_connect_api_key(key_id:, issuer_id:, key_content:)`).

## Notes

- Web previews (`npm run web`) exist only as a smoke test of the screens; on the web the native tab bar, SF Symbols and sheets are replaced by react-native-web stand-ins and do not look like iOS.
- Sign-in, sessions and limits: the API applies the web's limits (10 code requests and 10 code attempts per 10 minutes per IP and per email, 20 proposals a day, 30 messages a minute). Signing out deletes the session on the server; "Sign out everywhere" on the web signs the phone out too.
