import { proposalChangedOutput } from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"

import { TermsForm } from "@/components/terms-form"
import { api } from "@/lib/api"
import { notifySuccess } from "@/lib/haptics"

/** Counter-offer (§12 proposals): new terms on the table, as a native sheet over the proposal. */
export default function CounterSheet() {
  const params = useLocalSearchParams<{
    proposalId: string
    revisionId: string
    scope: string
    creatorPct: string
    weeks: string
  }>()
  const creator = Number(params.creatorPct) || 50

  return (
    <>
      <Stack.Screen options={{ title: "Counter-offer" }} />
      <TermsForm
        intro="Change what doesn't work for you. The other side then accepts, counters or declines; the 14 days start again."
        initial={{
          scope: params.scope ?? "",
          message: "",
          creatorSplitPct: creator,
          builderSplitPct: 100 - creator,
          timelineWeeks: params.weeks ?? "4",
        }}
        submitLabel="Send counter-offer"
        onSubmit={async (terms) => {
          await api(proposalChangedOutput, "POST", `/proposals/${params.proposalId}/counter`, {
            revisionId: params.revisionId,
            ...terms,
          })
          notifySuccess()
          router.back()
        }}
      />
    </>
  )
}
