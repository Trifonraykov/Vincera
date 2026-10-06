import { describe, expect, it } from "vitest"

import { renderMarkdown } from "@/lib/markdown"

describe("renderMarkdown (§14)", () => {
  it("renders the allowed Markdown", () => {
    const html = renderMarkdown("**Bold** and _em_\n\n- one\n- two\n\n`code`")
    expect(html).toContain("<strong>Bold</strong>")
    expect(html).toContain("<em>em</em>")
    expect(html).toContain("<li>one</li>")
    expect(html).toContain("<code>code</code>")
  })

  it("keeps single line breaks and demotes headings below the page's own", () => {
    expect(renderMarkdown("line one\nline two")).toContain("line one<br />")
    expect(renderMarkdown("# Big")).toBe("<h3>Big</h3>")
  })

  it("drops raw HTML, scripts, event handlers and images", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(1)">![alt](https://x.test/b.png)<b onclick="x()">hi</b>',
    )
    expect(html).not.toMatch(/<script|<img|onerror|onclick|alert\(1\)<\/script>/)
    expect(html).toContain("hi")
  })

  it("allows only http(s) and mailto links, opened safely in a new tab", () => {
    const html = renderMarkdown(
      "[ok](https://example.test) [bad](javascript:alert(1)) [rel](//evil.test)",
    )
    expect(html).toContain(
      '<a href="https://example.test" target="_blank" rel="nofollow noopener noreferrer">ok</a>',
    )
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain('href="//evil.test"')
  })

  it("returns an empty string for blank input", () => {
    expect(renderMarkdown("  \n ")).toBe("")
  })
})

describe("renderMarkdown raw links", () => {
  it("overrides target and rel on raw HTML links", () => {
    const html = renderMarkdown('<a href="https://example.test" target="_self" rel="opener">x</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="nofollow noopener noreferrer"')
    expect(html).not.toContain("_self")
  })
})
