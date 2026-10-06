import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AgeGenderChart } from "@/components/audience/age-gender-chart"
import { CountryBars } from "@/components/audience/country-bars"
import { SizeTierBadge } from "@/components/audience/size-tier-badge"
import { GitHubStatsSection } from "@/components/public-profile/github-stats"
import { PlatformList } from "@/components/public-profile/platform-list"
import { PortfolioList } from "@/components/public-profile/portfolio-list"
import { ConnectResultAlert } from "@/components/social/connect-result-alert"
import { connectHref } from "@/components/social/connect-button"
import SocialExpiredEmail from "@/lib/email/templates/social-expired"

/** Server-rendered audience, public-profile and social components (markup and accessibility). */

const UPDATED = new Date("2026-10-05T12:00:00Z")

describe("AgeGenderChart", () => {
  const html = renderToStaticMarkup(
    createElement(AgeGenderChart, {
      caption: "YouTube: share of viewers by age group and gender",
      ageGender: {
        basis: "viewers",
        buckets: [
          { ageGroup: "18-24", gender: "female", share: 0.142 },
          { ageGroup: "18-24", gender: "male", share: 0.169 },
          { ageGroup: "25-34", gender: "female", share: 0.175 },
          { ageGroup: "25-34", gender: "other", share: 0.01 },
          { ageGroup: "65+", gender: "male", share: 0.004 },
        ],
      },
    }),
  )

  it("has a legend with totals and a table view", () => {
    expect(html).toContain("Female")
    expect(html).toContain("31.7%")
    expect(html).toContain("Other or unspecified")
    expect(html).toContain("<caption")
    expect(html).toContain("Show as a table")
    // Age groups in order, with an en dash.
    expect(html.indexOf("18–24")).toBeLessThan(html.indexOf("25–34"))
    expect(html.indexOf("25–34")).toBeLessThan(html.indexOf("65+"))
    // The visual bars are hidden from screen readers (the table carries the numbers).
    expect(html).toContain('aria-hidden="true"')
  })
})

describe("CountryBars", () => {
  it("lists countries by share with their names", () => {
    const html = renderToStaticMarkup(
      createElement(CountryBars, {
        caption: "Top countries by share of viewers",
        basis: "viewers",
        countries: [
          { country: "US", share: 0.15 },
          { country: "ES", share: 0.3 },
        ],
      }),
    )
    expect(html.indexOf("Spain")).toBeLessThan(html.indexOf("United States"))
    expect(html).toContain("30.0%")
    expect(html).toContain("Share of viewers")
    expect(html).toContain('scope="row"')
  })
})

describe("public profile parts", () => {
  it("marks verified and unverified platforms and links only verified ones", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformList, {
        platforms: [
          {
            provider: "youtube",
            label: "YouTube",
            verified: true,
            stale: false,
            followers: 48_200,
            avgViews: 9_100,
            engagementRate: 0.051,
            updatedAt: UPDATED,
            profileUrl: "https://www.youtube.com/@adacodes",
          },
          {
            provider: "instagram",
            label: "Instagram",
            verified: false,
            stale: false,
            followers: 12_500,
            avgViews: null,
            engagementRate: null,
            updatedAt: UPDATED,
            profileUrl: null,
          },
        ],
      }),
    )
    expect(html).toContain("48.2K")
    expect(html).toContain("12.5K")
    expect(html).toContain("Verified")
    expect(html).toContain("Unverified")
    expect(html).toContain('href="https://www.youtube.com/@adacodes"')
    expect(html.match(/View on/g)).toHaveLength(1)
  })

  it("shows GitHub stats and portfolio items", () => {
    const github = renderToStaticMarkup(
      createElement(GitHubStatsSection, {
        github: {
          login: "octo",
          profileUrl: "https://github.com/octo",
          followers: 120,
          current: true,
          updatedAt: UPDATED,
          stats: {
            login: "octo",
            publicRepos: 12,
            totalStars: 1_234,
            totalForks: 40,
            topLanguages: [{ name: "TypeScript", bytes: 1000, share: 0.8 }],
            topRepos: [
              {
                name: "invoice-cli",
                url: "https://github.com/octo/invoice-cli",
                stars: 900,
                forks: 20,
                language: "TypeScript",
                pushedAt: null,
                archived: false,
              },
            ],
            contributions: {
              from: "2025-10-05T00:00:00Z",
              to: "2026-10-05T00:00:00Z",
              total: 850,
              commits: 700,
              issues: 50,
              pullRequests: 80,
              reviews: 20,
              repositories: 3,
              restricted: 0,
            },
          },
        },
      }),
    )
    expect(github).toContain("Stars earned")
    expect(github).toContain("1.2K")
    expect(github).toContain("TypeScript")
    expect(github).toContain("invoice-cli")

    const portfolio = renderToStaticMarkup(
      createElement(PortfolioList, {
        items: [
          {
            title: "Invoice CLI",
            url: "https://example.test",
            description: "Bills",
            isShipped: true,
            format: "tool",
            imageSrc: "/api/portfolio/0199a000-0000-7000-8000-000000000001/image?v=abc",
          },
          {
            title: "Draft idea",
            url: null,
            description: null,
            isShipped: false,
            format: null,
            imageSrc: null,
          },
        ],
      }),
    )
    expect(portfolio).toContain("Shipped")
    expect(portfolio).toContain('rel="noopener noreferrer nofollow ugc"')
    expect(portfolio.match(/href=/g)).toHaveLength(1)
    expect(portfolio.match(/<img /g)).toHaveLength(1)
    expect(portfolio).toContain('alt="Invoice CLI: project image"')
  })

  it("flags an unverified size tier", () => {
    const verified = renderToStaticMarkup(
      createElement(SizeTierBadge, { tier: "micro", verified: true }),
    )
    const unverified = renderToStaticMarkup(
      createElement(SizeTierBadge, { tier: "macro", verified: false, showRange: true }),
    )
    expect(verified).toContain("Micro creator")
    expect(verified).not.toContain("Unverified")
    expect(unverified).toContain("Macro creator")
    expect(unverified).toContain("over 500K followers")
    expect(unverified).toContain("Unverified")
  })
})

describe("connection flow UI", () => {
  it("builds the start link with the return path", () => {
    expect(connectHref("github", "/onboarding/builder/portfolio")).toBe(
      "/api/oauth/github/start?returnTo=%2Fonboarding%2Fbuilder%2Fportfolio",
    )
  })

  it("explains callback results in plain language", () => {
    const error = renderToStaticMarkup(
      createElement(ConnectResultAlert, {
        searchParams: { error: "account_in_use", provider: "youtube" },
      }),
    )
    expect(error).toContain("YouTube wasn&#x27;t connected")
    expect(error).toContain("already connected to a different account")
    const connected = renderToStaticMarkup(
      createElement(ConnectResultAlert, { searchParams: { connected: "tiktok" } }),
    )
    expect(connected).toContain("TikTok connected")
    expect(
      renderToStaticMarkup(
        createElement(ConnectResultAlert, { searchParams: { connected: "myspace" } }),
      ),
    ).toBe("")
  })

  it("renders the social.expired email with the reconnect link", () => {
    const html = renderToStaticMarkup(
      createElement(SocialExpiredEmail, {
        appName: "Vincera",
        provider: "YouTube",
        accountName: "Ada Codes",
        reconnectUrl: "http://localhost:3000/app/settings/connections",
      }),
    )
    expect(html).toContain("Reconnect your YouTube account")
    expect(html).toContain("Ada Codes")
    expect(html).toContain('href="http://localhost:3000/app/settings/connections"')
  })
})
