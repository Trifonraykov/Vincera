/**
 * Where the app finds the Vincera backend. `EXPO_PUBLIC_API_URL` is inlined at build time
 * (mobile/README.md); the default suits the iOS Simulator on the Mac that runs `pnpm dev`, because
 * the Simulator shares the Mac's localhost.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
)

/** Development builds point people at the fake mailbox, where sign-in codes land (§19.3). */
export const DEV_MAILBOX_URL = `${API_URL}/api/dev/mailbox`
