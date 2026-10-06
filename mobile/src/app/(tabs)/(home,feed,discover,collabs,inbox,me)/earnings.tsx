import { earningsOutput } from "@shared/schemas"
import * as WebBrowser from "expo-web-browser"
import { StyleSheet, Text, View } from "react-native"

import { api } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { formatDate, formatMoney } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { Loaded, Message, Padded, Row, Screen, Section } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * Earnings (§12 `/app/earnings`): your share of sales after the hold period (§9), what's on
 * hold, paid out, and recent sales. Payout settings stay on the web (Stripe).
 */
export default function EarningsScreen() {
  const me = useMe()
  const theme = useTheme()
  const state = useApi(() => api(earningsOutput, "GET", "/earnings"))
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Loaded state={state}>
        {(earnings) => (
          <>
            {earnings.balances.length === 0 ? (
              <Message
                icon="eurosign.circle"
                title="No earnings yet"
                body="When a launch sells, your share shows up here after the hold period."
              />
            ) : (
              earnings.balances.map((balance) => (
                <View key={balance.currency}>
                  <Padded>
                    <Text style={{ color: theme.secondaryLabel }}>
                      Available ({balance.currency.toUpperCase()})
                    </Text>
                    <Text style={[styles.big, { color: theme.label }]}>
                      {formatMoney(balance.availableCents, balance.currency)}
                    </Text>
                  </Padded>
                  <Section>
                    <Row
                      title="In the hold period"
                      detail={formatMoney(balance.pendingCents, balance.currency)}
                    />
                    {balance.onHoldCents !== 0 ? (
                      <Row
                        title="On hold (chargeback)"
                        detail={formatMoney(balance.onHoldCents, balance.currency)}
                      />
                    ) : null}
                    <Row
                      title="Paid out"
                      detail={formatMoney(balance.paidOutCents, balance.currency)}
                      last
                    />
                  </Section>
                </View>
              ))
            )}

            {earnings.releases.length > 0 ? (
              <Section title="Coming out of the hold">
                {earnings.releases.slice(0, 5).map((release, index, list) => (
                  <Row
                    key={`${release.date}-${release.currency}`}
                    title={formatDate(release.date)}
                    detail={formatMoney(release.amountCents, release.currency)}
                    last={index === list.length - 1}
                  />
                ))}
              </Section>
            ) : null}

            {earnings.recentSales.length > 0 ? (
              <Section
                title="Recent sales"
                footer={
                  earnings.feePendingCount > 0
                    ? `${earnings.feePendingCount} sale(s) wait for Stripe's fee before your share is known.`
                    : undefined
                }
              >
                {earnings.recentSales.map((sale, index) => (
                  <Row
                    key={sale.orderId}
                    title={sale.launchTitle}
                    subtitle={`${formatDate(sale.paidAt)} · ${sale.status === "paid" ? "Paid" : sale.status.replace("_", " ")}`}
                    detail={
                      sale.shareCents === null
                        ? "Fee pending"
                        : formatMoney(sale.shareCents, sale.currency)
                    }
                    last={index === earnings.recentSales.length - 1}
                  />
                ))}
              </Section>
            ) : null}

            <Section footer="Payouts go to your bank through Stripe once you've set them up.">
              <Row
                icon="banknote"
                title={earnings.payouts === "ready" ? "Payouts are ready" : "Set up payouts"}
                subtitle="Opens Settings → Payouts on the web"
                onPress={() => void WebBrowser.openBrowserAsync(`${me.webUrl}app/settings/payouts`)}
                last
              />
            </Section>
          </>
        )}
      </Loaded>
    </Screen>
  )
}

const styles = StyleSheet.create({
  big: { fontSize: 40, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: SPACING.xs },
})
