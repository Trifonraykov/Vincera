import { Package, Plus } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { ImportListingsSection } from "@/components/listings/import-section"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { formatPrice } from "@/components/supply/format"
import { SupplyStatusFilter } from "@/components/supply/status-filter"
import { SupplyCard, SupplyCardItem, SupplyCardList } from "@/components/supply/supply-card"
import { Button } from "@/components/ui/button"
import { canCreateProduct } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { PRODUCT_STAGE_LABELS } from "@/lib/products/fields"
import { countOwnProducts, findBuilderProfileId, listOwnProducts } from "@/lib/products/queries"
import { PRODUCT_FORMAT_LABELS } from "@/lib/profiles/fields"
import { filterCounts, filterLabel, parseSupplyFilter } from "@/lib/supply/lifecycle"

export const metadata: Metadata = { title: "Products" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

function NewProductButton({ className }: { className?: string }) {
  return (
    <Button asChild className={className}>
      <Link href="/app/products/new">
        <Plus aria-hidden="true" />
        New product
      </Link>
    </Button>
  )
}

/**
 * Builder → Products (§12 `/app/products`): the builder's products with a status filter
 * (`?status=`), each opening `/app/products/[id]`. On phones "New product" is the app bar's
 * action; on desktop it sits in the header.
 */
export default async function ProductsPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()

  if (!canCreateProduct(user)) {
    return (
      <div className="space-y-8">
        <PageHeader title="Products" />
        <EmptyState
          icon={Package}
          title="Products are for builders"
          description="Add the builder role to list what you've built and find creators to sell it with."
          action={
            <Button asChild size="sm">
              <Link href={ONBOARDING_STEP_PATHS.role}>Become a builder</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const db = getDb()
  if (!(await findBuilderProfileId(db, user.id))) {
    return (
      <div className="space-y-8">
        <PageHeader title="Products" />
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
      </div>
    )
  }

  const filter = parseSupplyFilter((await searchParams).status)
  const [products, byStatus] = await Promise.all([
    listOwnProducts(db, user.id, filter),
    countOwnProducts(db, user.id),
  ])
  const counts = filterCounts("product", byStatus)
  const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0)

  return (
    <div className="space-y-6">
      <AppBarSlot
        action={
          <Button asChild size="icon" className="size-11">
            <Link href="/app/products/new" aria-label="New product">
              <Plus aria-hidden="true" />
            </Link>
          </Button>
        }
      />
      <PageHeader
        title="Products"
        description="What you've built or plan to build. Publish a product and creators can team up with you to sell it."
        actions={<NewProductButton className="hidden md:inline-flex" />}
      />

      <ImportListingsSection db={db} userId={user.id} />

      {total === 0 ? (
        <EmptyState
          icon={Package}
          title="List your first product"
          description="A tool, template, app or AI utility that needs an audience. It can be an idea, a prototype or already live."
          action={<NewProductButton />}
        />
      ) : (
        <>
          <SupplyStatusFilter
            kind="product"
            basePath="/app/products"
            current={filter}
            counts={counts}
          />
          {products.length === 0 ? (
            <EmptyState
              title={`No products in “${filterLabel("product", filter)}”`}
              description="Pick another filter to see the rest."
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href="/app/products">Show all products</Link>
                </Button>
              }
            />
          ) : (
            <SupplyCardList label="Your products">
              {products.map((product) => (
                <SupplyCardItem key={product.id}>
                  <SupplyCard
                    kind="product"
                    href={`/app/products/${product.id}`}
                    title={product.title}
                    status={product.status}
                    facts={[
                      PRODUCT_FORMAT_LABELS[product.format],
                      PRODUCT_STAGE_LABELS[product.stage].title,
                      formatPrice(product.targetPriceCents, product.currency),
                      product.exclusivity ? "Exclusive" : null,
                    ]}
                    topics={product.topics}
                    updatedAt={product.updatedAt}
                  />
                </SupplyCardItem>
              ))}
            </SupplyCardList>
          )}
        </>
      )}
    </div>
  )
}
