import { Section, Text } from "react-email"

import { emailStyles } from "./layout"

/** The numbers of an offer, as the proposal emails show them. */
export type ProposalEmailTerms = {
  creatorSplitPct: number
  builderSplitPct: number
  timelineWeeks: number
}

const box = {
  backgroundColor: "#fafafa",
  border: "1px solid #e5e5e5",
  borderRadius: "8px",
  padding: "12px 16px",
  margin: "0 0 16px",
}

/** Split and timeline of an offer (no free text: the scope and message stay in the app). */
export function ProposalTermsBlock({ terms }: { terms: ProposalEmailTerms }) {
  const weeks = terms.timelineWeeks === 1 ? "1 week" : `${terms.timelineWeeks} weeks`
  return (
    <Section style={box}>
      <Text style={{ ...emailStyles.text, margin: "0 0 4px" }}>
        <strong>Split:</strong> creator {terms.creatorSplitPct}% · builder {terms.builderSplitPct}%
      </Text>
      <Text style={{ ...emailStyles.text, margin: 0 }}>
        <strong>Timeline:</strong> {weeks}
      </Text>
    </Section>
  )
}
