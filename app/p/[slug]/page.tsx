import { CircleSlash, Download, ExternalLink, KeyRound } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { cache } from "react"

import { BuyForm, ProductPageBeacon } from "@/components/launches/product-page-client"
import { MarkdownText } from "@/components/supply/markdown-text"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { getDb } from "@/lib/db/client"
import type { DeliveryType } from "@/lib/db/schema/enums"
import { env } from "@/lib/env"
import { isValidSlug, launchMediaPath, PRICE_TAX_NOTE } from "@/lib/launches/fields"
import { loadPublicLaunch } from "@/lib/launches/queries"
import { formatMoney } from "@/lib/money"

/**
 * The public product page (§12 `/p/[slug]`, CLAUDE.md §19.31–§19.32): static, rendered on first
 * visit and revalidated on demand whenever the launch changes (`revalidateLaunchPage` after going
 * live, pausing, resuming, ending, or an edit of a paused launch), plus an hourly safety net. It
 * shows "by @creator × @builder" with links to their public profiles, the media, the sanitized
 * description, the price (VAT included) and a Buy button that posts to `/p/<slug>/checkout`.
 * Paused and ended launches say the product is not available (status 200); launches that never
 * went live, and unknown slugs, are 404s. A beacon records `product_page.viewed` (no PII).
 */

export const revalidate = 3600

/** Rendered on first visit, then cached (no launch is prerendered at build time). */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return []
}

type Props = { params: Promise<{ slug: string }> }

const loadLaunch = cache((slug: string) =>
  isValidSlug(slug) ? loadPublicLaunch(getDb(), slug) : Promise.resolve(null),
)

const DELIVERY: Record<DeliveryType, { icon: typeof Download; text: string }> = {
  file: { icon: Download, text: "Instant download after payment" },
  license_key: { icon: KeyRound, text: "Your license key right after payment" },
  url: { icon: ExternalLink, text: "Instant access online after payment" },
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const launch = await loadLaunch(slug)
  if (!launch) return { title: "Product not found", robots: { index: false, follow: false } }
  const by = [launch.creator?.name, launch.builder?.name].filter(Boolean).join(" × ")
  const description = (launch.tagline ?? `${launch.title}${by ? ` by ${by}` : ""}`).slice(0, 160)
  const image = launch.media[0]
  return {
    title: launch.title,
    description,
    alternates: { canonical: `/p/${launch.slug}` },
    robots: launch.status === "live" ? undefined : { index: false, follow: true },
    openGraph: {
      type: "website",
      title: launch.title,
      description,
      url: `/p/${launch.slug}`,
      siteName: env.APP_NAME,
      ...(image
        ? { images: [{ url: launchMediaPath(launch.id, image.url), alt: image.alt }] }
        : {}),
    },
    twitter: { card: image ? "summary_large_image" : "summary", title: launch.title, description },
  }
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params
  const launch = await loadLaunch(slug)
  if (!launch) notFound()

  const price = formatMoney(launch.priceCents, launch.currency)
  const delivery = DELIVERY[launch.deliveryType]
  const DeliveryIcon = delivery.icon
  const [cover, ...gallery] = launch.media

  return (
    <article className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <ProductPageBeacon slug={launch.slug} />
      <div className="min-w-0 space-y-6">
        <header className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-balance break-words">
            {launch.title}
          </h1>
          {launch.tagline ? (
            <p className="text-lg text-pretty text-muted-foreground">{launch.tagline}</p>
          ) : null}
          {launch.creator || launch.builder ? (
            <p className="text-sm text-muted-foreground">
              by{" "}
              {launch.creator ? (
                <Link
                  href={`/c/${launch.creator.handle}`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  @{launch.creator.handle}
                </Link>
              ) : null}
              {launch.creator && launch.builder ? " × " : null}
              {launch.builder ? (
                <Link
                  href={`/b/${launch.builder.handle}`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  @{launch.builder.handle}
                </Link>
              ) : null}
            </p>
          ) : null}
        </header>

        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element -- a redirect to a signed URL
          <img
            src={launchMediaPath(launch.id, cover.url)}
            alt={cover.alt}
            className="aspect-video w-full rounded-xl border bg-muted object-cover"
          />
        ) : null}
        {gallery.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="More images">
            {gallery.map((item) => (
              <li key={item.url}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a redirect to a signed URL */}
                <img
                  src={launchMediaPath(launch.id, item.url)}
                  alt={item.alt}
                  loading="lazy"
                  className="aspect-video w-full rounded-lg border bg-muted object-cover"
                />
              </li>
            ))}
          </ul>
        ) : null}

        {launch.descriptionMd ? (
          <section aria-label="About this product">
            <MarkdownText source={launch.descriptionMd} className="text-base" />
          </section>
        ) : null}
      </div>

      <aside
        aria-label="Buy"
        className="space-y-4 rounded-xl border bg-card p-5 shadow-xs lg:sticky lg:top-6"
      >
        {launch.status === "live" ? (
          <>
            <div className="space-y-1">
              <p className="text-3xl font-semibold tabular-nums">{price}</p>
              <p className="text-sm text-muted-foreground">One-time payment. {PRICE_TAX_NOTE}</p>
            </div>
            <BuyForm slug={launch.slug} priceLabel={price} />
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <DeliveryIcon className="size-4 shrink-0" aria-hidden="true" />
              {delivery.text}
            </p>
            <p className="text-xs text-muted-foreground">
              Secure payment by Stripe. You don&apos;t need an account: we email you a link to your
              purchase.
            </p>
          </>
        ) : (
          <Alert>
            <CircleSlash aria-hidden="true" />
            <AlertTitle>
              {launch.status === "paused" ? "Not available right now" : "No longer available"}
            </AlertTitle>
            <AlertDescription>
              {launch.status === "paused"
                ? "Sales of this product are paused. Check back soon."
                : "This product isn't sold any more. If you bought it, your access link still works."}
            </AlertDescription>
          </Alert>
        )}
      </aside>
    </article>
  )
}
