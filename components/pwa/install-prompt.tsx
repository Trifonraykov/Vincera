"use client"

import { Download, Share, SquarePlus, X } from "lucide-react"
import { usePathname } from "next/navigation"
import { useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { LogoMark } from "@/components/shared/logo"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  iosInstallSteps,
  rememberInstallDismissed,
  wasInstallDismissed,
  type IosBrowser,
} from "@/lib/pwa/install"

import { useInstall } from "./use-install"

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

const noSubscribe = () => () => undefined

/**
 * "Install the app" card at the bottom of the app's home page (`/app`), for people who are past
 * onboarding (the app shell only renders for them). Chrome and Edge (Android, desktop) get an
 * Install button that opens the browser's dialog; iPhone and iPad get the Share → Add to Home
 * Screen steps, worded for Safari, Chrome or another browser. Hidden when the app already runs
 * installed, when the browser cannot install it (an app's built-in browser, such as Instagram's,
 * included), and for 60 days after "Not now" (remembered in localStorage, per browser). The Me
 * page keeps a permanent "Install the app" row (`InstallAppButton`).
 */
export function InstallPrompt() {
  const pathname = usePathname()
  const { method, iosBrowser, install } = useInstall()
  // Read once on the client; the server and hydration render nothing.
  const dismissedEarlier = useSyncExternalStore(
    noSubscribe,
    () => wasInstallDismissed(safeLocalStorage(), Date.now()),
    () => true,
  )
  const [dismissed, setDismissed] = useState(false)
  const [iosStepsOpen, setIosStepsOpen] = useState(false)

  if (pathname !== "/app") return null
  if (dismissed || dismissedEarlier) return null
  if (method !== "prompt" && method !== "ios") return null

  const dismiss = () => {
    rememberInstallDismissed(safeLocalStorage(), Date.now())
    setDismissed(true)
  }

  return (
    <aside
      aria-labelledby="install-app-title"
      data-install-prompt=""
      className="relative mt-8 flex items-start gap-3 rounded-xl border bg-card p-4 pr-12 shadow-xs"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <LogoMark />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="space-y-1">
          <h2 id="install-app-title" className="text-sm font-semibold">
            Install the app
          </h2>
          <p className="text-sm text-pretty text-muted-foreground">
            Open it from your home screen, full screen, like any other app.
          </p>
        </div>
        {method === "prompt" ? (
          <Button
            type="button"
            size="sm"
            onClick={async () => {
              const accepted = await install()
              if (accepted) toast.success("Installed. Find the app on your home screen.")
            }}
          >
            <Download aria-hidden="true" />
            Install
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" onClick={() => setIosStepsOpen(true)}>
              <Share aria-hidden="true" />
              Show me how
            </Button>
            <IosInstallSheet
              browser={iosBrowser ?? "safari"}
              open={iosStepsOpen}
              onOpenChange={setIosStepsOpen}
            />
          </>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2"
        aria-label="Not now: hide the install suggestion"
        onClick={dismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </aside>
  )
}

/** The Me page's "Install the app" row action: the browser's dialog, or the iPhone steps. */
export function InstallAppButton() {
  const { method, iosBrowser, install } = useInstall()
  const [iosStepsOpen, setIosStepsOpen] = useState(false)

  if (method === "installed") {
    return <span className="text-sm text-muted-foreground">Installed</span>
  }
  if (method === "in_app") {
    return (
      <span className="text-right text-xs text-muted-foreground">
        Open this page in Safari to install
      </span>
    )
  }
  if (method === "unavailable") {
    return (
      <span className="text-right text-xs text-muted-foreground">Use your browser&apos;s menu</span>
    )
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={async () => {
          if (method === "ios") {
            setIosStepsOpen(true)
            return
          }
          const accepted = await install()
          if (accepted) toast.success("Installed. Find the app on your home screen.")
        }}
      >
        Install
      </Button>
      {method === "ios" ? (
        <IosInstallSheet
          browser={iosBrowser ?? "safari"}
          open={iosStepsOpen}
          onOpenChange={setIosStepsOpen}
        />
      ) : null}
    </>
  )
}

/** Share → Add to Home Screen, as a bottom sheet (iPhone, iPad), for Safari, Chrome or others. */
function IosInstallSheet({
  browser,
  open,
  onOpenChange,
}: {
  browser: Exclude<IosBrowser, "in_app">
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const steps = iosInstallSteps(browser)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl pb-safe-6">
        <SheetHeader>
          <SheetTitle>Add the app to your home screen</SheetTitle>
          <SheetDescription>{steps.description}</SheetDescription>
        </SheetHeader>
        <ol className="space-y-4 px-4 text-sm">
          <li className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Share className="size-4" aria-hidden="true" />
            </span>
            <span>
              Tap <strong className="font-medium">Share</strong> {steps.share}.
            </span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <SquarePlus className="size-4" aria-hidden="true" />
            </span>
            <span>
              Choose <strong className="font-medium">Add to Home Screen</strong>, then{" "}
              <strong className="font-medium">Add</strong>.
            </span>
          </li>
        </ol>
        <p className="px-4 text-xs text-muted-foreground">
          On the home screen app, sign in with the code from your sign-in email: the app keeps its
          own sign-in, separate from {steps.browserName}.
        </p>
        <div className="px-4">
          <Button type="button" className="w-full" size="lg" onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
