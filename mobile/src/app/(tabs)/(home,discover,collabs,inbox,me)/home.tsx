import { homeOutput } from "@shared/schemas"
import { router } from "expo-router"
import * as WebBrowser from "expo-web-browser"

import { CollabRow, matchSubtitle, matchTitle, ProposalRow } from "@/components/rows"
import { api } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { useApi } from "@/lib/use-api"
import { Loaded, Message, Row, Screen, Section } from "@/ui/kit"

/** Home (§12 `/app`): what needs you now, your active collabs and your best matches. */
export default function HomeScreen() {
  const me = useMe()
  const state = useApi(() => api(homeOutput, "GET", "/home"))

  if (!me.onboarded) {
    return (
      <Screen>
        <Message
          icon="person.crop.circle.badge.checkmark"
          title="Finish setting up on the web"
          body="Pick your role, set up your profile and connect your accounts on the Vincera website. The app opens up as soon as you're done."
          action={
            me.onboardingUrl
              ? {
                  title: "Continue setup",
                  onPress: () => void WebBrowser.openBrowserAsync(me.onboardingUrl ?? me.webUrl),
                }
              : undefined
          }
        />
      </Screen>
    )
  }

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Loaded state={state}>
        {(home) => (
          <>
            {home.payouts !== "ready" ? (
              <Section footer="Both members need payouts set up before an agreement can be signed.">
                <Row
                  icon="eurosign.circle"
                  title={
                    home.payouts === "pending" ? "Payouts are being verified" : "Set up payouts"
                  }
                  subtitle="Opens Settings → Payouts on the web (Stripe)"
                  onPress={() =>
                    void WebBrowser.openBrowserAsync(`${me.webUrl}app/settings/payouts`)
                  }
                  last
                />
              </Section>
            ) : null}

            <Section title="Waiting for you">
              {home.proposalsAwaiting.length === 0 ? (
                <Row icon="checkmark.circle" title="No proposals need your answer" last />
              ) : (
                home.proposalsAwaiting.map((item, index) => (
                  <ProposalRow
                    key={item.id}
                    item={item}
                    last={index === home.proposalsAwaiting.length - 1}
                  />
                ))
              )}
            </Section>

            <Section title="Active collabs">
              {home.collabs.length === 0 ? (
                <Row
                  icon="person.2"
                  title="No active collabs yet"
                  subtitle="Accept a proposal to start one."
                  last
                />
              ) : (
                home.collabs.map((item, index) => (
                  <CollabRow key={item.id} item={item} last={index === home.collabs.length - 1} />
                ))
              )}
            </Section>

            <Section title="Top matches">
              {home.topMatches.length === 0 ? (
                <Row
                  icon="safari"
                  title="Open Discover"
                  onPress={() => router.push("/discover")}
                  last
                />
              ) : (
                home.topMatches.map((match, index) => (
                  <Row
                    key={match.id}
                    icon="sparkles"
                    title={matchTitle(match)}
                    subtitle={`${matchSubtitle(match)}\n${match.explanation}`}
                    onPress={() => router.push("/discover")}
                    last={index === home.topMatches.length - 1}
                  />
                ))
              )}
            </Section>

            <Section title="Your work">
              {home.role === "creator" ? (
                <Row
                  icon="lightbulb"
                  title="My ideas"
                  detail={`${home.supply.live} open`}
                  onPress={() => router.push("/ideas")}
                />
              ) : (
                <Row
                  icon="shippingbox"
                  title="My products"
                  detail={`${home.supply.live} live`}
                  onPress={() => router.push("/products")}
                />
              )}
              <Row icon="paperplane" title="Proposals" onPress={() => router.push("/proposals")} />
              {home.role === "creator" ? (
                <Row icon="chart.bar" title="Audience" onPress={() => router.push("/audience")} />
              ) : null}
              <Row
                icon="eurosign.circle"
                title="Earnings"
                onPress={() => router.push("/earnings")}
                last
              />
            </Section>
          </>
        )}
      </Loaded>
    </Screen>
  )
}
