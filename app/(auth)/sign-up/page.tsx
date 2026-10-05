import type { Metadata } from "next"
import Link from "next/link"

import { EmailSignInForm } from "@/components/auth/email-sign-in-form"
import { OAuthButtons } from "@/components/auth/oauth-buttons"
import { configuredOAuthProviders } from "@/lib/auth/config"
import { AUTH_ROUTES } from "@/lib/auth/routes"

import { AuthCard } from "../_components/auth-card"
import { readAuthParams, withCallback, type AuthSearchParams } from "../_lib/search-params"

export const metadata: Metadata = { title: "Create your account" }

export default async function SignUpPage({ searchParams }: { searchParams: AuthSearchParams }) {
  const { callbackUrl, error } = await readAuthParams(searchParams)

  return (
    <AuthCard
      title="Create your account"
      description="Team up with creators and builders to make and sell small digital products."
      error={error}
      footer={
        <>
          Already have an account?{" "}
          <Link
            href={withCallback(AUTH_ROUTES.signIn, callbackUrl)}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <OAuthButtons providers={configuredOAuthProviders()} callbackUrl={callbackUrl} />
      <EmailSignInForm intent="sign-up" callbackUrl={callbackUrl} />
      <p className="text-center text-xs text-pretty text-muted-foreground">
        By creating an account you agree to the{" "}
        <Link href="/legal/terms" className="underline underline-offset-4 hover:text-foreground">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/legal/privacy" className="underline underline-offset-4 hover:text-foreground">
          Privacy Policy
        </Link>
        .
      </p>
    </AuthCard>
  )
}
