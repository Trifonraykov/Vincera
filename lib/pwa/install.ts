/**
 * "Install the app" logic (components/pwa/install-prompt.tsx). Client-safe, pure where it can be:
 * the browser objects are passed in, so unit tests can call everything.
 */

/** Chrome's install event (Android, desktop); not in TypeScript's DOM types. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
}

/** How this browser can install the app, if at all. */
export type InstallMethod =
  /** Already running as the installed app (or installed just now). */
  | "installed"
  /** Chrome/Edge kept a `beforeinstallprompt` event: our button opens the browser's dialog. */
  | "prompt"
  /** iPhone/iPad: no install event; Share → Add to Home Screen, which we explain. */
  | "ios"
  /**
   * An app's built-in browser (Instagram, TikTok, Facebook, LinkedIn, …): it has no Share menu or
   * Add to Home Screen, so the page has to be opened in a real browser first.
   */
  | "in_app"
  | "unavailable"

export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true
  // iPadOS asks for desktop sites and says "Macintosh"; only the touch screen gives it away.
  return /\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1
}

/**
 * Apps whose links open in their own web view. Their user agents add these tokens (Facebook and
 * Messenger FBAN/FBAV, Instagram, TikTok musical_ly/BytedanceWebview, LinkedIn, LINE, Snapchat,
 * Pinterest, X/Twitter, the Google app GSA, WeChat MicroMessenger).
 */
const IN_APP_BROWSER =
  /\b(?:FBAN|FBAV|FB_IAB|FBIOS|Instagram|TikTok|musical_ly|BytedanceWebview|LinkedInApp|Line\/\d|Snapchat|Pinterest|Twitter|GSA\/\d|MicroMessenger)/i

/**
 * Which iOS browser this is, for the Add to Home Screen steps (Safari, and since iOS 16.4 Chrome,
 * Firefox and Edge, can add a web app to the home screen; an app's built-in browser cannot).
 * Null when it is not an iPhone or iPad.
 */
export type IosBrowser = "safari" | "chrome" | "other" | "in_app"

export function iosBrowser(userAgent: string, maxTouchPoints: number): IosBrowser | null {
  if (!isIos(userAgent, maxTouchPoints)) return null
  // A WKWebView inside an app reports no "Safari/" token; some add their own name instead.
  if (IN_APP_BROWSER.test(userAgent) || !/\bSafari\//.test(userAgent)) return "in_app"
  if (/\bCriOS\//.test(userAgent)) return "chrome"
  if (/\b(?:FxiOS|EdgiOS|OPiOS|OPT|YaBrowser|DuckDuckGo|Ddg)\//.test(userAgent)) return "other"
  return "safari"
}

/** Running from the home screen: standalone display mode, or iOS's own flag. */
export function isStandalone(
  matchMedia: ((query: string) => { matches: boolean }) | undefined,
  navigatorStandalone: boolean | undefined,
): boolean {
  if (navigatorStandalone === true) return true
  return matchMedia?.("(display-mode: standalone)").matches === true
}

export function installMethod(input: {
  standalone: boolean
  installed: boolean
  hasPromptEvent: boolean
  ios: IosBrowser | null
}): InstallMethod {
  if (input.standalone || input.installed) return "installed"
  if (input.hasPromptEvent) return "prompt"
  if (input.ios === "in_app") return "in_app"
  if (input.ios) return "ios"
  return "unavailable"
}

/** The Add to Home Screen steps, worded for the iOS browser at hand. */
export function iosInstallSteps(browser: Exclude<IosBrowser, "in_app">): {
  description: string
  share: string
  browserName: string
} {
  switch (browser) {
    case "safari":
      return {
        description: "Two taps in Safari, then it opens like any other app.",
        share: "in Safari's toolbar",
        browserName: "Safari",
      }
    case "chrome":
      return {
        description: "Two taps in Chrome, then it opens like any other app.",
        share: "in the address bar",
        browserName: "Chrome",
      }
    case "other":
      return {
        description: "Two taps in your browser, then it opens like any other app.",
        share: "in your browser's menu",
        browserName: "your browser",
      }
  }
}

/** localStorage key for "Not now" on the install card (per browser, never sent anywhere). */
export const INSTALL_DISMISSED_KEY = "pwa:install-dismissed"

/** "Not now" holds for this long; then the card may come back once. */
export const INSTALL_DISMISS_DAYS = 60

type StorageLike = Pick<Storage, "getItem" | "setItem">

/**
 * Whether the person said "Not now" recently. Storage can be missing or throw (private mode,
 * blocked site data); then the card shows, and "Not now" still hides it until the next load.
 */
export function wasInstallDismissed(storage: StorageLike | undefined, nowMs: number): boolean {
  try {
    const value = storage?.getItem(INSTALL_DISMISSED_KEY)
    if (!value) return false
    const at = Number(value)
    if (!Number.isFinite(at)) return false
    return nowMs - at < INSTALL_DISMISS_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

export function rememberInstallDismissed(storage: StorageLike | undefined, nowMs: number): void {
  try {
    storage?.setItem(INSTALL_DISMISSED_KEY, String(nowMs))
  } catch {
    // Not remembered; the card hides for this page view only.
  }
}
