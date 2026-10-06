import { proposalChangedOutput, proposalDetailSchema, type ProposalDetail } from "@shared/schemas"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useState } from "react"
import { Alert, StyleSheet, Text, View } from "react-native"

import { api, errorMessage } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { formatDate, formatRelative, formatTimeLeft, STATUS_LABELS } from "@/lib/format"
import { notifySuccess } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Body, Button, Loaded, Padded, Pill, Row, Screen, Section } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * A proposal (§12 `/app/proposals/[id]`): the offer on the table, the history of offers, and the
 * viewer's actions: accept, counter (a native sheet), decline, or withdraw their own offer.
 */
export default function ProposalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const state = useApi(() => api(proposalDetailSchema, "GET", `/proposals/${id}`), id)
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Stack.Screen options={{ title: "Proposal", headerLargeTitleEnabled: false }} />
      <Loaded state={state}>
        {(proposal) => <ProposalBody proposal={proposal} reload={state.reload} />}
      </Loaded>
    </Screen>
  )
}

function ProposalBody({ proposal, reload }: { proposal: ProposalDetail; reload: () => void }) {
  const me = useMe()
  const theme = useTheme()
  const [busy, setBusy] = useState<string | null>(null)
  const current =
    proposal.revisions.find((revision) => revision.id === proposal.currentRevisionId) ??
    proposal.revisions.at(-1)
  const nameOf = (userId: string) =>
    proposal.parties.find((party) => party.userId === userId)?.name ?? "Someone"
  const other = proposal.parties.find((party) => party.userId !== me.id)

  async function answer(action: "accept" | "decline" | "withdraw") {
    setBusy(action)
    try {
      const result = await api(
        proposalChangedOutput,
        "POST",
        `/proposals/${proposal.id}/${action}`,
        action === "withdraw" ? {} : { revisionId: proposal.currentRevisionId },
      )
      notifySuccess()
      if (result.collabId) router.push(`/collab/${result.collabId}`)
      else reload()
    } catch (error) {
      Alert.alert("Couldn't do that", errorMessage(error))
      reload()
    } finally {
      setBusy(null)
    }
  }

  const confirm = (
    title: string,
    body: string,
    action: "accept" | "decline" | "withdraw",
    destructive = false,
  ) =>
    Alert.alert(title, body, [
      { text: "Cancel", style: "cancel" },
      {
        text: title.split(" ")[0] ?? "OK",
        style: destructive ? "destructive" : "default",
        onPress: () => void answer(action),
      },
    ])

  const open = proposal.status === "pending" || proposal.status === "countered"
  const yourTurn = proposal.awaitingUserId === me.id

  return (
    <>
      <Padded>
        <Text style={[styles.title, { color: theme.label }]}>{proposal.target.title}</Text>
        <Text style={{ color: theme.secondaryLabel, fontSize: 15 }}>
          {proposal.fromUserId === me.id ? "You proposed to" : "Proposal from"}{" "}
          {other?.name ?? "them"}
        </Text>
        <View style={styles.pills}>
          <Pill
            label={STATUS_LABELS[proposal.status] ?? proposal.status}
            tone={open ? "tint" : "neutral"}
          />
          {open ? (
            <Pill label={`Expires ${formatTimeLeft(proposal.expiresAt)}`} tone="warning" />
          ) : null}
        </View>
        {open ? (
          <Body muted>
            {yourTurn
              ? "Your turn: accept, counter or decline."
              : `Waiting for ${proposal.awaitingUserId ? nameOf(proposal.awaitingUserId) : "them"} to answer.`}
          </Body>
        ) : null}
      </Padded>

      {current ? (
        <Section
          title="On the table"
          footer={`Offer ${current.revisionNumber} by ${nameOf(current.authorUserId)}, ${formatRelative(current.createdAt)}`}
        >
          <Row title="Creator's share" detail={`${current.creatorSplitPct}%`} />
          <Row title="Builder's share" detail={`${current.builderSplitPct}%`} />
          <Row title="Timeline" detail={`${current.timelineWeeks} weeks`} />
          <Padded>
            <Body>{current.scope}</Body>
            {current.message ? <Body muted>“{current.message}”</Body> : null}
          </Padded>
        </Section>
      ) : null}

      {proposal.actions.length > 0 ? (
        <Padded style={{ marginTop: SPACING.md }}>
          {proposal.actions.includes("accept") ? (
            <Button
              title="Accept"
              icon="checkmark.circle.fill"
              busy={busy === "accept"}
              onPress={() =>
                confirm(
                  "Accept these terms?",
                  `${current?.creatorSplitPct}% creator / ${current?.builderSplitPct}% builder over ${current?.timelineWeeks} weeks. A collab and its agreement are created.`,
                  "accept",
                )
              }
            />
          ) : null}
          {proposal.actions.includes("counter") && current ? (
            <Button
              title="Counter-offer"
              kind="tinted"
              icon="arrow.left.arrow.right"
              onPress={() =>
                router.push(
                  `/counter?${new URLSearchParams({
                    proposalId: proposal.id,
                    revisionId: current.id,
                    scope: current.scope,
                    creatorPct: String(current.creatorSplitPct),
                    weeks: String(current.timelineWeeks),
                  }).toString()}`,
                )
              }
            />
          ) : null}
          {proposal.actions.includes("decline") ? (
            <Button
              title="Decline"
              kind="plain"
              busy={busy === "decline"}
              onPress={() =>
                confirm(
                  "Decline this proposal?",
                  "They'll be told. This can't be undone.",
                  "decline",
                  true,
                )
              }
            />
          ) : null}
          {proposal.actions.includes("withdraw") ? (
            <Button
              title="Withdraw"
              kind="plain"
              busy={busy === "withdraw"}
              onPress={() =>
                confirm(
                  "Withdraw your offer?",
                  "The proposal closes. This can't be undone.",
                  "withdraw",
                  true,
                )
              }
            />
          ) : null}
        </Padded>
      ) : null}

      {proposal.collabId ? (
        <Section>
          <Row
            icon="person.2.fill"
            title="Open the collab"
            onPress={() => router.push(`/collab/${proposal.collabId}`)}
            last
          />
        </Section>
      ) : null}
      {proposal.threadId ? (
        <Section>
          <Row
            icon="bubble.left.and.bubble.right"
            title="Messages"
            onPress={() => router.push(`/thread/${proposal.threadId}`)}
            last
          />
        </Section>
      ) : null}

      <Section title="History">
        {[...proposal.revisions].reverse().map((revision, index) => (
          <Row
            key={revision.id}
            title={`Offer ${revision.revisionNumber} · ${nameOf(revision.authorUserId)}`}
            subtitle={`${revision.creatorSplitPct}/${revision.builderSplitPct} · ${revision.timelineWeeks} weeks · ${formatDate(revision.createdAt)}`}
            last={index === proposal.revisions.length - 1}
          />
        ))}
      </Section>
    </>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 28, fontWeight: "700" },
  pills: { flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: SPACING.sm },
})
