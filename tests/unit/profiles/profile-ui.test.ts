import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { RoleForm } from "@/app/onboarding/role/role-form"
import { BuilderProfileForm } from "@/components/profiles/builder-profile-form"
import { CreatorProfileForm } from "@/components/profiles/creator-profile-form"
import { PortfolioManager } from "@/components/profiles/portfolio-manager"
import { TagInput } from "@/components/profiles/tag-input"
import { ActiveRoleForm } from "@/components/settings/active-role-form"

/**
 * Server-rendered profile forms (CLAUDE.md §19.17): the markup a phone gets before hydration,
 * labels and descriptions wired up, tags as a labelled list with remove buttons and one hidden
 * comma-list field, and the portfolio image route.
 */

describe("TagInput", () => {
  const html = renderToStaticMarkup(
    createElement(TagInput, {
      id: "skills",
      name: "skills",
      label: "skill",
      defaultValue: ["Web apps", "AI tools"],
      max: 12,
      describedBy: "skills-hint",
    }),
  )

  it("lists the tags with a remove button each and submits them as one field", () => {
    expect(html).toContain('aria-label="Added skills"')
    expect(html).toContain('aria-label="Remove skill Web apps"')
    expect(html).toContain('type="hidden" name="skills" value="Web apps, AI tools"')
    expect(html).toMatch(/<input id="skills" type="text"[^>]*aria-describedby="skills-hint"/)
  })
})

describe("CreatorProfileForm", () => {
  const html = renderToStaticMarkup(
    createElement(CreatorProfileForm, {
      source: "onboarding",
      defaults: {
        displayName: "Maya",
        handle: "maya",
        niche: null,
        bio: null,
        topics: ["meal prep"],
        country: null,
        languages: ["en"],
      },
      countries: [{ code: "ES", name: "Spain" }],
      languages: [
        { code: "en", name: "English" },
        { code: "es", name: "Spanish" },
      ],
    }),
  )

  it("has the handle with its public URL and live status, topics as tags, and Continue", () => {
    expect(html).toContain("/c/<span")
    expect(html).toMatch(/aria-describedby="[^"]*-hint [^"]*-status" name="handle"/)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('name="topics" value="meal prep"')
    expect(html).toContain("Topics")
    expect(html).toContain('checked="" value="en"')
    expect(html).toContain(">Continue")
  })
})

describe("BuilderProfileForm", () => {
  it("renders skills and stack as tags and saves in settings", () => {
    const html = renderToStaticMarkup(
      createElement(BuilderProfileForm, {
        source: "settings",
        defaults: {
          displayName: "Ben",
          handle: "ben",
          bio: null,
          skills: ["Web apps"],
          stack: ["TypeScript"],
          availability: "open",
          dealPreference: "either",
        },
      }),
    )
    expect(html).toContain('name="skills" value="Web apps"')
    expect(html).toContain('name="stack" value="TypeScript"')
    expect(html).toContain('aria-label="Added tools"')
    expect(html).toContain("/b/<span")
    expect(html).toContain("Save builder profile")
  })
})

describe("PortfolioManager", () => {
  it("shows a project's image through the image route", () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioManager, {
        source: "settings",
        items: [
          {
            id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
            title: "Invoice generator",
            url: "https://invoices.example.com/",
            description: null,
            format: "tool",
            isShipped: true,
            imageSrc: "/api/portfolio/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/image?v=abc",
          },
          {
            id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
            title: "No image",
            url: null,
            description: null,
            format: null,
            isShipped: false,
            imageSrc: null,
          },
        ],
      }),
    )
    expect(html).toContain('src="/api/portfolio/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/image?v=abc"')
    expect(html.match(/<img/g)).toHaveLength(1)
    expect(html).toContain('Edit<span class="sr-only"> Invoice generator</span>')
  })
})

describe("RoleForm", () => {
  it("explains each role and names each radio by its title", () => {
    const html = renderToStaticMarkup(createElement(RoleForm, { currentRoles: ["creator"] }))
    expect(html).toContain("I&#x27;m a creator")
    expect(html).toContain("Post ideas your audience keeps asking for")
    expect(html).toContain("List products that need an audience")
    expect(html).toMatch(/disabled=""[^>]*name="choice" value="creator"/)
    expect(html).toMatch(/aria-labelledby="[^"]*-builder-title"/)
    expect(html).toContain("Your current role")
  })
})

describe("ActiveRoleForm", () => {
  it("marks the active role and offers to switch to the other", () => {
    const html = renderToStaticMarkup(
      createElement(ActiveRoleForm, { roles: ["creator", "builder"], activeRole: "creator" }),
    )
    expect(html).toContain('aria-label="Your roles"')
    expect(html).toContain("Active")
    expect(html).toContain('name="role" value="builder"')
    expect(html).toContain("Use as builder")
    expect(html).not.toContain("Use as creator")
  })
})
