import type { Metadata } from "next"
import Link from "next/link"

import { EmailSignInForm } from "@/components/auth/email-sign-in-form"
import { OAuthButtons } from "@/components/auth/oauth-buttons"
import { configuredOAuthProviders } from "@/lib/auth/config"
import { AUTH_ROUTES } from "@/lib/auth/routes"

import { AuthCard, CheckEmailNotice } from "../_components/auth-card"
import { readAuthParams, withCallback, type AuthSearchParams } from "../_lib/search-params"

export const metadata: Metadata = { title: "Sign in" }

export default async function SignInPage({ searchParams }: { searchParams: AuthSearchParams }) {
  const { callbackUrl, error, checkEmail } = await readAuthParams(searchParams)

  return (
    <AuthCard
      title="Sign in"
      description="Welcome back. We'll email you a link to sign in, no password needed."
      error={error}
      footer={
        <>
          New here?{" "}
          <Link
            href={withCallback(AUTH_ROUTES.signUp, callbackUrl)}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </>
      }
    >
      {checkEmail ? (
        <CheckEmailNotice />
      ) : (
        <>
          <OAuthButtons providers={configuredOAuthProviders()} callbackUrl={callbackUrl} />
          <EmailSignInForm intent="sign-in" callbackUrl={callbackUrl} />
        </>
      )}
    </AuthCard>
  )
}
