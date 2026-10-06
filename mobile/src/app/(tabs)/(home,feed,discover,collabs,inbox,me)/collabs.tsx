import { collabListOutput } from "@shared/schemas"
import { useState } from "react"

import { CollabRow } from "@/components/rows"
import { api } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { Loaded, Message, Screen, Section, Segmented } from "@/ui/kit"

/** Collabs (§12 `/app/collabs`): your collaborations, the ones waiting for you first. */
const FILTERS = [
  { value: "active", label: "Active" },
  { value: "all", label: "All" },
  { value: "ended", label: "Ended" },
] as const

export default function CollabsScreen() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("active")
  const state = useApi(() => api(collabListOutput, "GET", `/collabs?stage=${filter}`), filter)
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Segmented options={FILTERS} value={filter} onChange={setFilter} />
      <Loaded state={state}>
        {({ items }) =>
          items.length === 0 ? (
            <Message
              icon="person.2"
              title={filter === "ended" ? "No ended collabs" : "No collabs yet"}
              body="When someone accepts a proposal, the collab starts here: agreement, tasks and messages."
            />
          ) : (
            <Section>
              {[...items]
                .sort((a, b) => Number(b.nextStep.needsViewer) - Number(a.nextStep.needsViewer))
                .map((item, index) => (
                  <CollabRow key={item.id} item={item} last={index === items.length - 1} />
                ))}
            </Section>
          )
        }
      </Loaded>
    </Screen>
  )
}
