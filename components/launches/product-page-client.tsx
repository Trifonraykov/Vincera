"use client"

import { Loader2, ShoppingCart } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"

/**
 * The product page's small client parts (§12 `/p/[slug]`, which is static):
 *
 * - `ProductPageBeacon` posts `product_page.viewed` once per browser session with
 *   `navigator.sendBeacon` (sessionStorage, read in try/catch; without storage it posts once per
 *   page view), forwarding `?ref=` like the Buy form.
 * - `BuyForm` posts to `/p/<slug>/checkout` (the checkout builder's route) and forwards `?ref=`
 *   and `?code=` from the address in the form's own query string (the static page cannot read
 *   them on the server).
 */

export function ProductPageBeacon({ slug }: { slug: string }) {
  useEffect(() => {
    const key = `pv:${slug}`
    try {
      if (window.sessionStorage.getItem(key)) return
      window.sessionStorage.setItem(key, "1")
    } catch {
      // No storage (private mode, blocked): count this view anyway.
    }
    const url = viewBeaconUrl(slug, window.location.search)
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url)) return
    void fetch(url, { method: "POST", keepalive: true }).catch(() => undefined)
  }, [slug])
  return null
}

/**
 * `/p/<slug>/view` with the page's own `ref` when it looks valid, so a view is attributed like the
 * checkout when the `attr` cookie is blocked (§10; CLAUDE.md §19.37).
 */
export function viewBeaconUrl(slug: string, search: string): string {
  const ref = new URLSearchParams(search).get("ref")
  return ref && /^[A-Za-z0-9]{1,40}$/.test(ref)
    ? `/p/${slug}/view?ref=${encodeURIComponent(ref)}`
    : `/p/${slug}/view`
}

/** `/p/<slug>/checkout` with the page's own `ref` and `code` parameters, when they look valid. */
export function checkoutAction(slug: string, search: string): string {
  const params = new URLSearchParams(search)
  const forward = new URLSearchParams()
  for (const name of ["ref", "code"]) {
    const value = params.get(name)
    if (value && /^[A-Za-z0-9]{1,40}$/.test(value)) forward.set(name, value)
  }
  const query = forward.toString()
  return `/p/${slug}/checkout${query ? `?${query}` : ""}`
}

export function BuyForm({ slug, priceLabel }: { slug: string; priceLabel: string }) {
  const [submitting, setSubmitting] = useState(false)
  return (
    <form
      method="post"
      action={`/p/${slug}/checkout`}
      onSubmit={(event) => {
        event.currentTarget.action = checkoutAction(slug, window.location.search)
        setSubmitting(true)
      }}
    >
      <Button type="submit" size="lg" disabled={submitting} className="h-12 w-full text-base">
        {submitting ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <ShoppingCart aria-hidden="true" />
        )}
        Buy for {priceLabel}
      </Button>
    </form>
  )
}
