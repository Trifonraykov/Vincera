import { CircleAlert, MailCheck } from "lucide-react"
import type { ReactNode } from "react"

import { SignInCodeForm } from "@/components/auth/sign-in-code-form"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/** The card that frames /sign-in and /sign-up. */
export function AuthCard({
  title,
  description,
  error,
  children,
  footer,
}: {
  title: string
  description: string
  /** Plain-language error to show above the form (from `?error=`). */
  error?: string | null
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <Card className="gap-6">
      <CardHeader className="text-center">
        <CardTitle>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {children}
        <div className="text-center text-sm text-muted-foreground">{footer}</div>
      </CardContent>
    </Card>
  )
}

/** Shown when Auth.js redirects to its verify-request page (`?type=email`). */
export function CheckEmailNotice({ callbackUrl }: { callbackUrl?: string }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2 text-center" role="status">
        <MailCheck className="mx-auto size-10 text-primary" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="text-sm text-muted-foreground">
          We sent you a sign-in link and code. They work once and expire in 24 hours.
        </p>
      </div>
      <SignInCodeForm callbackUrl={callbackUrl} />
    </div>
  )
}
