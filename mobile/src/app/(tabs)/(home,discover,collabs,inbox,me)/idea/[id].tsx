import { ideaDetailSchema } from "@shared/schemas"
import { useLocalSearchParams } from "expo-router"

import { SupplyDetail } from "@/components/supply-detail"
import { api } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { Loaded, Screen } from "@/ui/kit"

/** An idea (§12 `/app/ideas/[id]`): drafts only for their owner; builders can propose. */
export default function IdeaScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const state = useApi(() => api(ideaDetailSchema, "GET", `/ideas/${id}`), id)
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Loaded state={state}>
        {(idea) => <SupplyDetail kind="idea" item={idea} onChanged={() => void state.reload()} />}
      </Loaded>
    </Screen>
  )
}
