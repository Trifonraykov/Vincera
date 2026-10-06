import type { LucideIcon } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { AUTH_LINKS } from "@/lib/nav"
import { cn } from "@/lib/utils"

import { formatEuros, type BreakdownLine } from "../_lib/economics"
import { Container } from "./section"

export type Feature = { icon: LucideIcon; title: string; description: string }

export function FeatureGrid({ features }: { features: Feature[] }) {
  return (
    <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
      {features.map(({ icon: Icon, title, description }) => (
        <div key={title} className="space-y-2">
          <Icon className="size-5 text-foreground" aria-hidden="true" />
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-pretty text-muted-foreground">{description}</p>
        </div>
      ))}
    </div>
  )
}

export type FaqItem = { question: string; answer: ReactNode }

/** Questions and answers using native disclosure, so it works without JavaScript. */
export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <div className="divide-y rounded-xl border">
      {items.map((item) => (
        <details
          key={item.question}
          className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
            {item.question}
            <span
              aria-hidden="true"
              className="text-muted-foreground transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <div className="mt-3 text-sm text-pretty text-muted-foreground">{item.answer}</div>
        </details>
      ))}
    </div>
  )
}

/** Line-by-line split of one example sale. */
export function BreakdownTable({ lines }: { lines: BreakdownLine[] }) {
  return (
    <table className="w-full max-w-xl text-sm">
      <caption className="sr-only">Example split of one sale</caption>
      <tbody className="divide-y">
        {lines.map((line) => (
          <tr key={line.label} className={cn(line.emphasis && "font-medium")}>
            <th scope="row" className="py-2.5 pr-4 text-left font-[inherit]">
              {line.label}
              {line.note ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ({line.note})
                </span>
              ) : null}
            </th>
            <td className="py-2.5 text-right tabular-nums">{formatEuros(line.cents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function CtaBand({ title, description }: { title: string; description: string }) {
  return (
    <section className="border-t bg-muted/40">
      <Container className="flex flex-col items-start gap-6 py-16 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">{title}</h2>
          <p className="text-pretty text-muted-foreground">{description}</p>
        </div>
        <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap">
          <Button asChild size="lg">
            <Link href={AUTH_LINKS.signUp}>Get started free</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/how-it-works">How it works</Link>
          </Button>
        </div>
      </Container>
    </section>
  )
}
