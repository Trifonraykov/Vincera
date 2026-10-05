import { GeistMono } from "geist/font/mono"
import { GeistSans } from "geist/font/sans"
import type { Metadata, Viewport } from "next"

import "./globals.css"

import { AnalyticsProvider } from "@/components/shared/analytics-provider"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { env } from "@/lib/env"

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
    title: { default: env.APP_NAME, template: `%s · ${env.APP_NAME}` },
    description: "Creators and builders team up to make and sell small digital products together.",
    applicationName: env.APP_NAME,
    // Added to the home screen, the app opens full screen like a native one (app/manifest.ts).
    appleWebApp: { capable: true, title: env.APP_NAME, statusBarStyle: "default" },
    formatDetection: { telephone: false },
  }
}

export const viewport: Viewport = {
  // Lets the layout reach under the home indicator; the bottom bars pad with
  // env(safe-area-inset-bottom).
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-svh font-sans antialiased">
        <AnalyticsProvider>
          <ThemeProvider>
            {children}
            {/* On phones, toasts sit above the app's bottom tab bar (--sticky-bottom). */}
            <Toaster
              richColors
              closeButton
              mobileOffset={{ bottom: "calc(16px + var(--sticky-bottom, 0px))" }}
            />
          </ThemeProvider>
        </AnalyticsProvider>
      </body>
    </html>
  )
}
