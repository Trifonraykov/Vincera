/**
 * The agreement text format (CLAUDE.md §19.28). An agreement's `rendered_body` is plain text, the
 * exact text both parties sign and whose SHA-256 is `body_hash`. The web view, the PDF and the
 * hash all use that one stored text, never a fresh rendering, so what is shown is what is signed.
 *
 * The text is a sequence of blocks separated by one blank line. A block's first characters say
 * what it is:
 *
 *   # Title            the agreement's title (first block)
 *   ## 1. Heading      a section heading
 *   - item             a list (every line starts with "- ")
 *   > quoted text      text a party wrote (the scope): every line starts with ">", so nothing a
 *                      party types can start a heading or end the block
 *   anything else      a paragraph (line breaks kept)
 *
 * Pure and client-safe: the template builds blocks and serializes them; the pages and the PDF
 * parse the stored text back into blocks.
 */

export type AgreementBlock =
  | { kind: "title"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; text: string }

/**
 * One line of text: control characters and line breaks become spaces, whitespace runs collapse.
 * Used for names and every value inserted into a template line.
 */
export function inlineText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Multi-line text a party wrote (CRLF → LF, tabs and other control characters → spaces, trailing
 * spaces dropped, leading and trailing blank lines dropped, runs of blank lines → one).
 */
export function multilineText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
}

function serializeBlock(block: AgreementBlock): string {
  switch (block.kind) {
    case "title":
      return `# ${inlineText(block.text)}`
    case "heading":
      return `## ${inlineText(block.text)}`
    case "list":
      return block.items.map((item) => `- ${inlineText(item)}`).join("\n")
    case "quote":
      return multilineText(block.text)
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n")
    case "paragraph":
      return multilineText(block.text)
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .join("\n")
  }
}

/** Blocks → the canonical agreement text (no trailing newline). */
export function serializeAgreementBlocks(blocks: readonly AgreementBlock[]): string {
  return blocks
    .map(serializeBlock)
    .filter((text) => text.length > 0)
    .join("\n\n")
}

/** The canonical agreement text → blocks (the inverse of `serializeAgreementBlocks`). */
export function parseAgreementBody(body: string): AgreementBlock[] {
  const text = body.replace(/\r\n?/g, "\n")
  return text
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block.length > 0)
    .map((block): AgreementBlock => {
      const lines = block.split("\n")
      if (lines.length === 1 && block.startsWith("# ")) {
        return { kind: "title", text: block.slice(2) }
      }
      if (lines.length === 1 && block.startsWith("## ")) {
        return { kind: "heading", text: block.slice(3) }
      }
      if (lines.every((line) => line === ">" || line.startsWith("> "))) {
        return {
          kind: "quote",
          text: lines.map((line) => (line === ">" ? "" : line.slice(2))).join("\n"),
        }
      }
      if (lines.every((line) => line.startsWith("- "))) {
        return { kind: "list", items: lines.map((line) => line.slice(2)) }
      }
      return { kind: "paragraph", text: block }
    })
}
