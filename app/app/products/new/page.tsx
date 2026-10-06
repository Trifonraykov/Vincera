import { Package } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { EMPTY_PRODUCT_DEFAULTS, ProductForm } from "@/components/products/product-form"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { canCreateProduct } from "@/lib/auth/authz"
import { authorizePage, requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { findBuilderProfileId } from "@/lib/products/queries"

export const metadata: Metadata = { title: "New product" }

/**
 * `/app/products/new` (§12): the product form. Builders only; others go back to `/app/products`,
 * which explains the role.
 */
export default async function NewProductPage() {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  authorizePage(canCreateProduct(user), "/app/products")
  const profileId = await findBuilderProfileId(getDb(), user.id)

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <AppBarSlot title="New product" back="/app/products" />
      <PageHeader
        title="New product"
        description="Describe what you've built, or plan to. Save it as a draft, or publish it so creators can find it."
      />
      {profileId ? (
        <ProductForm mode="create" defaults={EMPTY_PRODUCT_DEFAULTS} />
      ) : (
        <EmptyState
          icon={Package}
          title="Create your builder profile first"
          description="Products belong to your builder profile. It takes a minute."
          action={
            <Button asChild size="sm">
              <Link href={ONBOARDING_STEP_PATHS["builder.profile"]}>Create builder profile</Link>
            </Button>
          }
        />
      )}
    </div>
  )
}
