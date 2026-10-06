import { ideaListOutput, productListOutput, proposalChangedOutput } from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useState } from "react"
import { ScrollView } from "react-native"

import { TermsForm } from "@/components/terms-form"
import { api } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { notifySuccess } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Loaded, Message, Row, Section } from "@/ui/kit"
import { useTheme } from "@/ui/theme"

/**
 * Send a proposal (§12 `/app/proposals/new`) as a native sheet. From an idea or product it is
 * about that one; from a person (a creator or builder match) you first pick one of your own open
 * ideas (creators) or live products (builders), like the web's `?to=` without a target.
 */
export default function ProposeSheet() {
  const params = useLocalSearchParams<{
    to: string
    kind?: "idea" | "product"
    targetId?: string
    title?: string
    matchId?: string
    builderPct?: string
  }>()
  const [picked, setPicked] = useState<{
    kind: "idea" | "product"
    id: string
    title: string
  } | null>(
    params.kind && params.targetId
      ? { kind: params.kind, id: params.targetId, title: params.title ?? "" }
      : null,
  )
  const builderPct = params.builderPct ? Number(params.builderPct) : NaN
  const creatorPct = Number.isInteger(builderPct) ? 100 - builderPct : 50

  return (
    <>
      <Stack.Screen options={{ title: picked ? "Send a proposal" : "What is it about?" }} />
      {picked ? (
        <TermsForm
          intro={
            picked.title
              ? `About “${picked.title}”. They can accept, counter or decline.`
              : undefined
          }
          initial={{
            scope: "",
            message: "",
            creatorSplitPct: creatorPct,
            builderSplitPct: 100 - creatorPct,
            timelineWeeks: "4",
          }}
          submitLabel="Send proposal"
          onSubmit={async (terms) => {
            const result = await api(proposalChangedOutput, "POST", "/proposals", {
              to: params.to,
              targetKind: picked.kind,
              targetId: picked.id,
              matchId: params.matchId || undefined,
              ...terms,
            })
            notifySuccess()
            router.dismiss()
            router.push(`/proposal/${result.proposalId}`)
          }}
        />
      ) : (
        <TargetPicker onPick={setPicked} />
      )}
    </>
  )
}

function TargetPicker({
  onPick,
}: {
  onPick: (target: { kind: "idea" | "product"; id: string; title: string }) => void
}) {
  const me = useMe()
  const theme = useTheme()
  const kind = me.activeRole === "builder" ? "product" : "idea"
  const state = useApi(async () =>
    kind === "idea"
      ? (await api(ideaListOutput, "GET", "/ideas?status=live")).items
      : (await api(productListOutput, "GET", "/products?status=live")).items,
  )
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.background }}
    >
      <Loaded state={state}>
        {(items) =>
          items.length === 0 ? (
            <Message
              icon={kind === "idea" ? "lightbulb" : "shippingbox"}
              title={kind === "idea" ? "No open ideas" : "No live products"}
              body={`Publish ${kind === "idea" ? "an idea" : "a product"} first; a proposal is always about one.`}
            />
          ) : (
            <Section
              title={kind === "idea" ? "Your open ideas" : "Your live products"}
              footer="Pick what your proposal is about."
            >
              {items.map((item, index) => (
                <Row
                  key={item.id}
                  title={item.title}
                  onPress={() => onPick({ kind, id: item.id, title: item.title })}
                  last={index === items.length - 1}
                />
              ))}
            </Section>
          )
        }
      </Loaded>
    </ScrollView>
  )
}
