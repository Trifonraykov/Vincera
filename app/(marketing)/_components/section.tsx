import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>
}

/** A titled band of a marketing page. */
export function Section({
  id,
  eyebrow,
  title,
  description,
  children,
  className,
}: {
  id?: string
  eyebrow?: string
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section id={id} aria-labelledby={headingId} className={cn("py-16 sm:py-20", className)}>
      <Container>
        <div className="max-w-2xl space-y-3">
          {eyebrow ? (
            <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
              {eyebrow}
            </p>
          ) : null}
          <h2 id={headingId} className="text-3xl font-semibold tracking-tight text-balance">
            {title}
          </h2>
          {description ? (
            <p className="text-lg text-pretty text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {children ? <div className="mt-10">{children}</div> : null}
      </Container>
    </section>
  )
}

/** Page-top hero with heading, intro and actions. */
export function Hero({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: ReactNode
  description: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="border-b bg-gradient-to-b from-muted/50 to-background">
      <Container className="py-16 sm:py-24">
        <div className="max-w-3xl space-y-6">
          {eyebrow ? (
            <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            {title}
          </h1>
          <p className="max-w-2xl text-lg text-pretty text-muted-foreground sm:text-xl">
            {description}
          </p>
          {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
        </div>
      </Container>
    </section>
  )
}
