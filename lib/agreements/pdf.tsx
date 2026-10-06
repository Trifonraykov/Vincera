import "server-only"

import { existsSync } from "node:fs"
import path from "node:path"

import type { CollabRole } from "@/lib/db/schema"
import { sanitizeFilename, storageKey } from "@/lib/storage/keys"

import { parseAgreementBody, type AgreementBlock } from "./body"

/**
 * The signed agreement as a PDF (§2 `@react-pdf/renderer`, §12 "generate the PDF, store it, email
 * it"). It prints the stored `rendered_body` (the exact text both parties signed, parsed into the
 * same blocks as the web view), then a signature record per party (typed name, role, time, the
 * fingerprint they signed) and, on every page, the agreement id, its SHA-256 fingerprint and the
 * page number. The PDF is emailed to both parties, so it never prints a party's IP address or
 * browser: those stay in `agreement_signatures` as evidence for admins and disputes (§14,
 * CLAUDE.md §19.30).
 *
 * `@react-pdf/renderer` is imported lazily: it is an ES module whose internals Node cannot
 * `require()`, and `tsx` scripts (the seed) compile to CommonJS. Next.js keeps it external on the
 * server by default.
 *
 * Text is set in Geist (Latin, Latin Extended and Cyrillic), from TTF files committed next to this
 * module (`lib/agreements/fonts/`, SIL OFL) and traced into the functions that render PDFs
 * (`outputFileTracingIncludes` in next.config.ts). A missing font is an error, never a silent
 * fallback to Helvetica, whose Latin-1 encoding would mangle names such as "Łukasz Żółć" in the
 * legal record: the finalize step fails, is reported and retried.
 */

export type PdfSignature = {
  userId: string
  role: CollabRole
  typedName: string
  signedAt: Date
  bodyHash: string
}

export type AgreementPdfInput = {
  agreementId: string
  body: string
  bodyHash: string
  signatures: readonly PdfSignature[]
}

/** Where the signed PDF is stored (CLAUDE.md §19.24): `agreements/<collabId>/<agreementId>.pdf`. */
export function agreementPdfKey(collabId: string, agreementId: string): string {
  return storageKey("agreements", collabId, `${agreementId}.pdf`)
}

/** The file name people get: `collaboration-agreement-<title>.pdf`. */
export function agreementPdfFilename(collabTitle: string): string {
  const stem = sanitizeFilename(collabTitle.toLowerCase()).replace(/\.+/g, "-").slice(0, 60)
  return `collaboration-agreement-${stem || "collab"}.pdf`
}

type ReactPdf = typeof import("@react-pdf/renderer")

/** Where the PDF fonts live, relative to the app's root (the working directory). */
export const AGREEMENT_FONT_DIR = path.join("lib", "agreements", "fonts")

export class AgreementFontMissingError extends Error {
  constructor(file: string) {
    super(`agreement PDF: font file missing (${file}); check outputFileTracingIncludes`)
    this.name = "AgreementFontMissingError"
  }
}

/** The font files, checked to exist. Throws `AgreementFontMissingError` otherwise. */
export function agreementFontFiles(dir: string = path.join(process.cwd(), AGREEMENT_FONT_DIR)): {
  regular: string
  semibold: string
} {
  const regular = path.join(dir, "Geist-Regular.ttf")
  const semibold = path.join(dir, "Geist-SemiBold.ttf")
  for (const file of [regular, semibold]) {
    if (!existsSync(file)) throw new AgreementFontMissingError(path.basename(file))
  }
  return { regular, semibold }
}

let fontsRegistered = false

function registerFonts(pdf: ReactPdf): string {
  if (!fontsRegistered) {
    const { regular, semibold } = agreementFontFiles()
    pdf.Font.register({
      family: "Geist",
      fonts: [{ src: regular }, { src: semibold, fontWeight: 600 }],
    })
    // Whole words only: hyphenation would change how the signed text reads.
    pdf.Font.registerHyphenationCallback((word) => [word])
    fontsRegistered = true
  }
  return "Geist"
}

const ROLE_LABELS: Record<CollabRole, string> = { creator: "the Creator", builder: "the Builder" }

function formatUtc(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`
}

export async function renderAgreementPdf(input: AgreementPdfInput): Promise<Buffer> {
  const pdf = await import("@react-pdf/renderer")
  const family = registerFonts(pdf)
  const bold = { fontWeight: 600 as const }
  const { Document, Page, Text, View, StyleSheet, renderToBuffer } = pdf

  const styles = StyleSheet.create({
    page: {
      paddingTop: 48,
      paddingBottom: 64,
      paddingHorizontal: 56,
      fontFamily: family,
      fontSize: 10.5,
      lineHeight: 1.5,
      color: "#171717",
    },
    title: { fontSize: 20, marginBottom: 12, ...bold },
    heading: { fontSize: 12.5, marginTop: 14, marginBottom: 6, ...bold },
    paragraph: { marginBottom: 8 },
    list: { marginBottom: 8 },
    listItem: { flexDirection: "row", marginBottom: 3 },
    bullet: { width: 12 },
    listText: { flex: 1 },
    quote: {
      marginBottom: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderLeftWidth: 2,
      borderLeftColor: "#a3a3a3",
      backgroundColor: "#f5f5f5",
    },
    record: {
      marginTop: 10,
      padding: 10,
      borderWidth: 1,
      borderColor: "#e5e5e5",
      borderRadius: 4,
    },
    signedName: { fontSize: 14, marginBottom: 4, ...bold },
    meta: { fontSize: 9, color: "#525252" },
    footer: {
      position: "absolute",
      left: 56,
      right: 56,
      bottom: 28,
      fontSize: 8,
      color: "#737373",
      flexDirection: "row",
      justifyContent: "space-between",
    },
  })

  const renderBlock = (block: AgreementBlock, index: number) => {
    switch (block.kind) {
      case "title":
        return (
          <Text key={index} style={styles.title}>
            {block.text}
          </Text>
        )
      case "heading":
        return (
          <Text key={index} style={styles.heading} minPresenceAhead={40}>
            {block.text}
          </Text>
        )
      case "list":
        return (
          <View key={index} style={styles.list}>
            {block.items.map((item, itemIndex) => (
              <View key={itemIndex} style={styles.listItem} wrap={false}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.listText}>{item}</Text>
              </View>
            ))}
          </View>
        )
      case "quote":
        return (
          <View key={index} style={styles.quote}>
            <Text>{block.text}</Text>
          </View>
        )
      case "paragraph":
        return (
          <Text key={index} style={styles.paragraph}>
            {block.text}
          </Text>
        )
    }
  }

  const document = (
    <Document
      title="Collaboration agreement"
      subject={`Agreement ${input.agreementId}`}
      creator="Collaboration agreement (template v1)"
      producer="react-pdf"
      language="en"
    >
      <Page size="A4" style={styles.page}>
        {parseAgreementBody(input.body).map(renderBlock)}

        <View break={false} wrap={false}>
          <Text style={styles.heading}>Signature record</Text>
          <Text style={styles.paragraph}>
            Both Parties signed the text above by typing their full name on the Platform. Its
            SHA-256 fingerprint is {input.bodyHash}. The Platform keeps the technical record of each
            signature as evidence.
          </Text>
        </View>
        {input.signatures.map((signature) => (
          <View key={signature.userId} style={styles.record} wrap={false}>
            <Text style={styles.signedName}>{signature.typedName}</Text>
            <Text style={styles.meta}>
              Signed as {ROLE_LABELS[signature.role]}, platform account {signature.userId}
            </Text>
            <Text style={styles.meta}>Signed at {formatUtc(signature.signedAt)}</Text>
            <Text style={styles.meta}>Text signed (SHA-256): {signature.bodyHash}</Text>
          </View>
        ))}

        <View style={styles.footer} fixed>
          <Text>
            Agreement {input.agreementId} · SHA-256 {input.bodyHash.slice(0, 16)}…
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
  return renderToBuffer(document)
}
