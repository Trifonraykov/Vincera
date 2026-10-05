import { Compass, Hammer, HandCoins, Rocket, Send, Signature, type LucideIcon } from "lucide-react"

type Step = {
  icon: LucideIcon
  title: string
  summary: string
  details: string[]
}

/** The six-step core loop (§1). `holdDays` comes from HOLD_DAYS so the copy stays accurate. */
export function coreLoop(holdDays: number): Step[] {
  return [
    {
      icon: Compass,
      title: "Match",
      summary:
        "Creators post ideas their audience is asking for. Builders list products that need distribution. We rank the best fits for both sides.",
      details: [
        "Creators connect YouTube, Instagram or TikTok, so audience size, countries and topics come from real data.",
        "Builders show their skills, stack and shipped work, and list products at any stage from idea to live.",
        "Matches weigh topic and audience fit, format, price and track record, and each one says why it was suggested.",
      ],
    },
    {
      icon: Send,
      title: "Propose",
      summary:
        "Either side sends a proposal with the scope, the revenue split and a timeline. The other side accepts, declines or counters.",
      details: [
        "Every counter-offer is kept, so both sides can see how the deal changed.",
        "Proposals expire after 14 days if nobody answers.",
      ],
    },
    {
      icon: Signature,
      title: "Agree",
      summary:
        "Both sign a standard collaboration agreement filled in with the deal's terms: parties, split, scope, ownership and exit.",
      details: [
        "Signing is a click plus your typed name. Both of you get the signed PDF by email.",
        "Both sides set up Stripe payouts before signing, so nobody works on a deal that cannot pay out.",
      ],
    },
    {
      icon: Hammer,
      title: "Build",
      summary:
        "A shared workspace keeps the tasks, messages and files for the collab in one place.",
      details: [
        "Plan the work as tasks with owners and due dates.",
        "Share files privately: they are only visible to the two of you.",
      ],
    },
    {
      icon: Rocket,
      title: "Launch",
      summary: "Both approve the public product page. The creator promotes it with a tracked link.",
      details: [
        "The product page shows who made it: by @creator × @builder.",
        "Tracked links show which posts drive clicks and sales.",
        "Get AI-drafted launch posts for each platform as a starting point.",
      ],
    },
    {
      icon: HandCoins,
      title: "Sell & split",
      summary:
        "Buyers pay through Stripe Checkout. Every sale is split between creator, builder and platform automatically.",
      details: [
        "Buyers get instant access by file download, license key or link. No account needed.",
        `Earnings are paid out to your bank through Stripe after a ${holdDays}-day hold, which covers refunds and chargebacks.`,
      ],
    },
  ]
}

/** Numbered grid of the six steps, summary only. */
export function CoreLoopGrid({ holdDays }: { holdDays: number }) {
  return (
    <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {coreLoop(holdDays).map((step, index) => {
        const Icon = step.icon
        return (
          <li key={step.title} className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">Step {index + 1}</span>
            </div>
            <h3 className="mt-4 font-semibold">{step.title}</h3>
            <p className="mt-1 text-sm text-pretty text-muted-foreground">{step.summary}</p>
          </li>
        )
      })}
    </ol>
  )
}
