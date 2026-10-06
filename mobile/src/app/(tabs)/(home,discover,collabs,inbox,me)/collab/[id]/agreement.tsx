import { agreementOutput, signAgreementOutput, type Agreement } from "@shared/schemas"
import { Stack, useLocalSearchParams } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { useState } from "react"
import { Alert, StyleSheet, Text, View } from "react-native"

import { api, ApiError, errorMessage } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { formatDate } from "@/lib/format"
import { notifyError, notifySuccess } from "@/lib/haptics"
import { useApi } from "@/lib/use-api"
import { Button, Field, Loaded, Message, Padded, Row, Screen, Section } from "@/ui/kit"
import { SPACING, useTheme } from "@/ui/theme"

/**
 * The collaboration agreement (§12 agreement page): the exact signed text, who has signed, and
 * the signature: type your full name. Both members need payouts set up first; the server checks
 * that the text you read is the stored one (`bodyHash`).
 */
export default function AgreementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const state = useApi(() => api(agreementOutput, "GET", `/collabs/${id}/agreement`), id)
  return (
    <Screen refreshing={state.refreshing} onRefresh={state.refresh}>
      <Stack.Screen options={{ title: "Agreement", headerLargeTitleEnabled: false }} />
      <Loaded state={state}>
        {({ agreement }) =>
          agreement ? (
            <AgreementBody agreement={agreement} reload={state.reload} />
          ) : (
            <Message
              icon="doc.text"
              title="No agreement in force"
              body="This collab has no agreement to sign."
            />
          )
        }
      </Loaded>
    </Screen>
  )
}

/** The stored text's small block format: `# `, `## `, `- `, `> `, paragraphs. */
function AgreementText({ body }: { body: string }) {
  const theme = useTheme()
  return (
    <View style={{ gap: SPACING.md }}>
      {body.split(/\n{2,}/).map((block, index) => {
        if (block.startsWith("# "))
          return (
            <Text key={index} style={[styles.h1, { color: theme.label }]}>
              {block.slice(2)}
            </Text>
          )
        if (block.startsWith("## "))
          return (
            <Text key={index} style={[styles.h2, { color: theme.label }]}>
              {block.slice(3)}
            </Text>
          )
        if (block.startsWith("> ")) {
          return (
            <View key={index} style={[styles.quote, { borderLeftColor: theme.separator }]}>
              <Text style={[styles.p, { color: theme.label }]}>
                {block
                  .split("\n")
                  .map((line) => line.replace(/^> ?/, ""))
                  .join("\n")}
              </Text>
            </View>
          )
        }
        if (block.startsWith("- ")) {
          return (
            <View key={index} style={{ gap: 4 }}>
              {block.split("\n").map((line, item) => (
                <Text key={item} style={[styles.p, { color: theme.label }]}>
                  • {line.replace(/^- /, "")}
                </Text>
              ))}
            </View>
          )
        }
        return (
          <Text key={index} style={[styles.p, { color: theme.label }]}>
            {block}
          </Text>
        )
      })}
    </View>
  )
}

function AgreementBody({ agreement, reload }: { agreement: Agreement; reload: () => void }) {
  const me = useMe()
  const theme = useTheme()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signed = agreement.signatures.some((signature) => signature.userId === me.id)

  async function sign() {
    setBusy(true)
    setError(null)
    try {
      const result = await api(signAgreementOutput, "POST", `/agreements/${agreement.id}/sign`, {
        typedName: name,
        bodyHash: agreement.bodyHash,
      })
      notifySuccess()
      Alert.alert(
        result.completed ? "Agreement signed by both of you" : "You signed the agreement",
        result.completed
          ? "The collab moves to building. The signed PDF is on its way by email."
          : "Your collaborator signs next.",
      )
      reload()
    } catch (caught) {
      notifyError()
      setError(
        caught instanceof ApiError
          ? (caught.field("typedName") ?? caught.message)
          : errorMessage(caught),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Section
        title="Signatures"
        footer={`Fingerprint ${agreement.bodyHash.slice(0, 12)}… · template ${agreement.templateVersion}`}
      >
        {agreement.members.map((member, index) => {
          const signature = agreement.signatures.find((item) => item.userId === member.userId)
          return (
            <Row
              key={member.userId}
              icon={signature ? "checkmark.seal.fill" : "signature"}
              iconColor={signature ? theme.success : theme.secondaryLabel}
              title={member.name}
              subtitle={
                signature
                  ? `Signed as “${signature.typedName}” on ${formatDate(signature.signedAt)}`
                  : member.payoutsReady
                    ? "Not signed yet"
                    : "Not signed yet · payouts not set up"
              }
              detail={`${member.splitPct}%`}
              last={index === agreement.members.length - 1}
            />
          )
        })}
      </Section>

      {agreement.status === "awaiting_signatures" && !signed ? (
        <Section title="Sign">
          <Padded>
            {agreement.blockedReason ? (
              <>
                <Text style={[styles.p, { color: theme.label }]}>{agreement.blockedReason}</Text>
                <Button
                  title="Set up payouts on the web"
                  kind="tinted"
                  icon="eurosign.circle"
                  onPress={() =>
                    void WebBrowser.openBrowserAsync(`${me.webUrl}app/settings/payouts`)
                  }
                />
              </>
            ) : (
              <>
                <Text style={[styles.p, { color: theme.secondaryLabel }]}>
                  Read the agreement below, then type your full name as on an ID document to sign
                  it.
                </Text>
                <Field
                  label="Your full name"
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="words"
                  textContentType="name"
                  autoComplete="name"
                  error={error}
                />
                <Button
                  title="Sign agreement"
                  icon="signature"
                  busy={busy}
                  disabled={!agreement.canSign || name.trim().length < 2}
                  onPress={() => void sign()}
                />
              </>
            )}
          </Padded>
        </Section>
      ) : null}

      <Section title="Agreement text">
        <Padded>
          <AgreementText body={agreement.renderedBody} />
        </Padded>
      </Section>
    </>
  )
}

const styles = StyleSheet.create({
  h1: { fontSize: 22, fontWeight: "700" },
  h2: { fontSize: 17, fontWeight: "600" },
  p: { fontSize: 16, lineHeight: 22 },
  quote: { borderLeftWidth: 3, paddingLeft: SPACING.md },
})
