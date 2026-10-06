import { productDetailSchema } from "@shared/schemas"
import { useLocalSearchParams } from "expo-router"

import { SupplyDetail } from "@/components/supply-detail"
import { api } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { Loaded, Screen } from "@/ui/kit"

/** A product (§12 `/app/products/[id]`): drafts only for their owner; creators can propose. */
export default function ProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const state = useApi(() => api(productDetailSchema, "GET", `/products/${id}`), id)
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Loaded state={state}>
        {(product) => (
          <SupplyDetail kind="product" item={product} onChanged={() => void state.reload()} />
        )}
      </Loaded>
    </Screen>
  )
}
