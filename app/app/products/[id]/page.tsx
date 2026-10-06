import { CheckCircle2, Send } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { AppBarSlot } from "@/components/layout/app-bar-slot"
import { ProductDetails } from "@/components/products/product-details"
import { ProductForm } from "@/components/products/product-form"
import { PageHeader } from "@/components/shared/page-header"
import { ArchiveButton, RestoreButton } from "@/components/supply/status-actions"
import { SupplyStatusPanel } from "@/components/supply/status-panel"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { canManageProduct, canViewProduct, hasRole } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { formatMoneyInput } from "@/lib/money-input"
import { isBuiltRoute } from "@/lib/nav"
import { countActiveCollabs, findProduct } from "@/lib/products/queries"
import { ownerActions } from "@/lib/supply/lifecycle"

export const metadata: Metadata = { title: "Product" }

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** The confirmation after a create, while the status it describes still holds. */
const SAVED_NOTICES: Record<string, { status: string; text: string }> = {
  created: { status: "draft", text: "Saved as a draft. Only you can see it until you publish it." },
  published: {
    status: "seeking",
    text: "Published. Creators can find your product and send you proposals.",
  },
}

/**
 * `/app/products/[id]` (§12). The owner edits it here while it is a draft or seeking (the form,
 * with Publish on drafts), archives it, or restores an archived one; in a collab (exclusive) or
 * launched it is read-only (lib/supply/lifecycle.ts). Other signed-in users see published products
 * only (`canViewProduct`); anything else is a 404.
 */
export default async function ProductPage({ params, searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const product = await findProduct(db, id)
  if (!product) notFound()
  const access = { ownerUserId: product.owner.userId, status: product.status }
  if (!canViewProduct(user, access)) notFound()

  const isOwner = canManageProduct(user, access)
  const actions = isOwner ? ownerActions("product", product.status) : []
  const activeCollabs =
    isOwner && product.status === "seeking" ? await countActiveCollabs(db, product.id) : 0
  const saved = (await searchParams).saved
  const savedNotice = isOwner && typeof saved === "string" ? SAVED_NOTICES[saved] : undefined
  const notice = savedNotice?.status === product.status ? savedNotice.text : undefined
  const canPropose =
    !isOwner &&
    product.status === "seeking" &&
    hasRole(user, "creator") &&
    isBuiltRoute("/app/proposals")

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AppBarSlot
        title={product.title}
        back={
          isOwner
            ? "/app/products"
            : isBuiltRoute("/app/discover/builders")
              ? "/app/discover/builders"
              : "/app"
        }
      />
      <PageHeader
        title={product.title}
        description={isOwner ? "Your product" : `A product by @${product.owner.handle}`}
      />

      {notice ? (
        <Alert>
          <CheckCircle2 aria-hidden="true" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {isOwner ? (
        <SupplyStatusPanel kind="product" status={product.status}>
          {actions.includes("archive") ? (
            <ArchiveButton kind="product" id={product.id} title={product.title} />
          ) : null}
          {actions.includes("restore") ? <RestoreButton kind="product" id={product.id} /> : null}
        </SupplyStatusPanel>
      ) : null}

      {activeCollabs > 0 ? (
        <p className="text-sm text-muted-foreground">
          {activeCollabs === 1
            ? "1 collab is running on this product."
            : `${activeCollabs} collabs are running on this product.`}{" "}
          Changes here don&apos;t change what you already agreed.
        </p>
      ) : null}

      {actions.includes("edit") ? (
        <ProductForm
          mode="edit"
          productId={product.id}
          status={product.status}
          defaults={{
            title: product.title,
            description: product.description ?? "",
            targetUser: product.targetUser ?? "",
            stage: product.stage,
            demoUrl: product.demoUrl ?? "",
            format: product.format,
            targetPrice: formatMoneyInput(product.targetPriceCents, product.currency),
            topics: product.topics,
            preferredSplitBuilderPct:
              product.preferredSplitBuilderPct === null
                ? ""
                : String(product.preferredSplitBuilderPct),
            exclusivity: product.exclusivity,
          }}
        />
      ) : (
        <ProductDetails product={product} showOwner={!isOwner} />
      )}

      {canPropose ? (
        <div className="flex justify-end">
          <Button asChild className="w-full sm:w-auto">
            <Link href={`/app/proposals/new?to=${product.owner.userId}&product=${product.id}`}>
              <Send aria-hidden="true" />
              Send a proposal
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  )
}
