import { proposalListOutput, type ProposalTab } from "@shared/schemas"
import { Stack } from "expo-router"
import { useState } from "react"

import { ProposalRow } from "@/components/rows"
import { api } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { Loaded, Message, Screen, Section, Segmented } from "@/ui/kit"

/** Proposals (§12 `/app/proposals`): received, sent and closed. */
export default function ProposalsScreen() {
  const [tab, setTab] = useState<ProposalTab>("received")
  const state = useApi(() => api(proposalListOutput, "GET", `/proposals?tab=${tab}`), tab)
  const counts = state.data?.counts
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Stack.Screen options={{ title: "Proposals" }} />
      <Segmented
        options={[
          { value: "received", label: `Received${counts ? ` ${counts.received}` : ""}` },
          { value: "sent", label: `Sent${counts ? ` ${counts.sent}` : ""}` },
          { value: "closed", label: "Closed" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Loaded state={state}>
        {({ items }) =>
          items.length === 0 ? (
            <Message
              icon="paperplane"
              title="Nothing here"
              body="Proposals you send and receive show up here."
            />
          ) : (
            <Section>
              {items.map((item, index) => (
                <ProposalRow key={item.id} item={item} last={index === items.length - 1} />
              ))}
            </Section>
          )
        }
      </Loaded>
    </Screen>
  )
}
