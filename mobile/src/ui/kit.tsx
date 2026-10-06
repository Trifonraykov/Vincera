import { SymbolView } from "expo-symbols"
import type { ReactNode } from "react"
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native"
import type { SFSymbol } from "sf-symbols-typescript"

import { tapLight } from "@/lib/haptics"

import { SPACING, useTheme } from "./theme"

/**
 * The app's building blocks, in the style of iOS inset grouped tables: a scrolling screen whose
 * content slides under the large title, sections with a header and footer, tappable rows with an
 * SF Symbol and a chevron, buttons and fields.
 */

export function Icon({
  name,
  size = 20,
  color,
}: {
  name: SFSymbol
  size?: number
  color?: string
}) {
  const theme = useTheme()
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color ?? theme.tint}
      fallback={<View style={{ width: size, height: size }} />}
    />
  )
}

type ScreenProps = ScrollViewProps & {
  children: ReactNode
  refreshing?: boolean
  onRefresh?: () => void
}

/** A scrolling screen; with `onRefresh`, pull to refresh. The large title collapses over it. */
export function Screen({ children, refreshing = false, onRefresh, style, ...rest }: ScreenProps) {
  const theme = useTheme()
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={[{ flex: 1, backgroundColor: theme.background }, style]}
      contentContainerStyle={{ paddingBottom: SPACING.xl * 2 }}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
      }
      {...rest}
    >
      {children}
    </ScrollView>
  )
}

export function Section({
  title,
  footer,
  children,
}: {
  title?: string
  footer?: string
  children: ReactNode
}) {
  const theme = useTheme()
  return (
    <View style={styles.section}>
      {title ? (
        <Text style={[styles.sectionTitle, { color: theme.secondaryLabel }]}>
          {title.toUpperCase()}
        </Text>
      ) : null}
      <View style={[styles.sectionBody, { backgroundColor: theme.card }]}>{children}</View>
      {footer ? (
        <Text style={[styles.sectionFooter, { color: theme.secondaryLabel }]}>{footer}</Text>
      ) : null}
    </View>
  )
}

type RowProps = {
  title: string
  subtitle?: string | null
  detail?: string | null
  icon?: SFSymbol
  iconColor?: string
  badge?: number
  onPress?: () => void
  destructive?: boolean
  last?: boolean
  accessibilityLabel?: string
  numberOfLines?: number
}

/** One table row. Rows with `onPress` get a chevron and haptic feedback. */
export function Row({
  title,
  subtitle,
  detail,
  icon,
  iconColor,
  badge,
  onPress,
  destructive,
  last,
  accessibilityLabel,
  numberOfLines = 2,
}: RowProps) {
  const theme = useTheme()
  const content = (
    <View style={styles.row}>
      {icon ? (
        <View style={styles.rowIcon}>
          <Icon name={icon} color={iconColor} />
        </View>
      ) : null}
      <View
        style={[
          styles.rowMain,
          !last && {
            borderBottomColor: theme.separator,
            borderBottomWidth: StyleSheet.hairlineWidth,
          },
        ]}
      >
        <View style={styles.rowText}>
          <Text
            numberOfLines={numberOfLines}
            style={[styles.rowTitle, { color: destructive ? theme.destructive : theme.label }]}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={3} style={[styles.rowSubtitle, { color: theme.secondaryLabel }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {detail ? (
          <Text style={[styles.rowDetail, { color: theme.secondaryLabel }]}>{detail}</Text>
        ) : null}
        {badge ? (
          <View style={[styles.badge, { backgroundColor: theme.destructive }]}>
            <Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text>
          </View>
        ) : null}
        {onPress ? <Icon name="chevron.right" size={13} color={theme.tertiaryLabel} /> : null}
      </View>
    </View>
  )
  if (!onPress) return content
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={() => {
        tapLight()
        onPress()
      }}
      style={({ pressed }) => (pressed ? { backgroundColor: theme.fill } : undefined)}
    >
      {content}
    </Pressable>
  )
}

/** A block of text inside a section (descriptions, terms, agreement text). */
export function Body({
  children,
  muted,
  style,
}: {
  children: ReactNode
  muted?: boolean
  style?: StyleProp<TextStyle>
}) {
  const theme = useTheme()
  return (
    <Text style={[styles.body, { color: muted ? theme.secondaryLabel : theme.label }, style]}>
      {children}
    </Text>
  )
}

export function Padded({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ padding: SPACING.lg, gap: SPACING.sm }, style]}>{children}</View>
}

type ButtonKind = "filled" | "tinted" | "plain" | "destructive"

export function Button({
  title,
  onPress,
  kind = "filled",
  disabled,
  busy,
  icon,
}: {
  title: string
  onPress: () => void
  kind?: ButtonKind
  disabled?: boolean
  busy?: boolean
  icon?: SFSymbol
}) {
  const theme = useTheme()
  const background =
    kind === "filled"
      ? theme.tint
      : kind === "destructive"
        ? theme.destructive
        : kind === "tinted"
          ? theme.tintSoft
          : "transparent"
  const color = kind === "filled" || kind === "destructive" ? "#FFFFFF" : theme.tint
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={() => {
        tapLight()
        onPress()
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <View style={styles.buttonInner}>
          {icon ? <Icon name={icon} size={17} color={color} /> : null}
          <Text style={[styles.buttonText, { color }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  )
}

export function Field({
  label,
  error,
  hint,
  style,
  ...input
}: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const theme = useTheme()
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.secondaryLabel }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.tertiaryLabel}
        style={[
          styles.input,
          {
            color: theme.label,
            backgroundColor: theme.card,
            borderColor: error ? theme.destructive : theme.separator,
          },
          input.multiline ? { minHeight: 96, textAlignVertical: "top" } : null,
          style,
        ]}
        {...input}
      />
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.fieldNote, { color: theme.destructive }]}
        >
          {error}
        </Text>
      ) : hint ? (
        <Text style={[styles.fieldNote, { color: theme.secondaryLabel }]}>{hint}</Text>
      ) : null}
    </View>
  )
}

/** A row of choices (role tabs, filters, formats): a native-feeling segmented control. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  const theme = useTheme()
  return (
    <View style={[styles.segmented, { backgroundColor: theme.fill }]} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) tapLight()
              onChange(option.value)
            }}
            style={[styles.segment, selected && { backgroundColor: theme.card }]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.segmentText,
                { color: theme.label, fontWeight: selected ? "600" : "400" },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Pill({
  label,
  tone = "neutral",
}: {
  label: string
  tone?: "neutral" | "tint" | "success" | "warning"
}) {
  const theme = useTheme()
  const color =
    tone === "tint"
      ? theme.tint
      : tone === "success"
        ? theme.success
        : tone === "warning"
          ? theme.warning
          : theme.secondaryLabel
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  )
}

export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator />
    </View>
  )
}

export function Message({
  icon,
  title,
  body,
  action,
}: {
  icon: SFSymbol
  title: string
  body?: string
  action?: { title: string; onPress: () => void }
}) {
  const theme = useTheme()
  return (
    <View style={styles.message}>
      <Icon name={icon} size={36} color={theme.tertiaryLabel} />
      <Text style={[styles.messageTitle, { color: theme.label }]}>{title}</Text>
      {body ? (
        <Text style={[styles.messageBody, { color: theme.secondaryLabel }]}>{body}</Text>
      ) : null}
      {action ? <Button title={action.title} kind="tinted" onPress={action.onPress} /> : null}
    </View>
  )
}

/** The standard loading / error frame around a screen's data. */
export function Loaded<T>({
  state,
  children,
}: {
  state: { data: T | null; error: string | null; reload: () => void }
  children: (data: T) => ReactNode
}) {
  if (state.data !== null) return <>{children(state.data)}</>
  if (state.error) {
    return (
      <Message
        icon="exclamationmark.triangle"
        title="Couldn't load this"
        body={state.error}
        action={{ title: "Try again", onPress: state.reload }}
      />
    )
  }
  return <Loading />
}

const styles = StyleSheet.create({
  section: { marginTop: SPACING.xl, marginHorizontal: SPACING.lg },
  sectionTitle: { fontSize: 13, marginBottom: 6, marginLeft: SPACING.lg },
  sectionBody: { borderRadius: 10, overflow: "hidden" },
  sectionFooter: { fontSize: 13, marginTop: 6, marginHorizontal: SPACING.lg, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", paddingLeft: SPACING.lg, minHeight: 44 },
  rowIcon: { width: 28, marginRight: SPACING.md, alignItems: "center" },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    paddingRight: SPACING.lg,
    gap: SPACING.sm,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 17 },
  rowSubtitle: { fontSize: 15, lineHeight: 20 },
  rowDetail: { fontSize: 17 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 23 },
  button: {
    minHeight: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.lg,
  },
  buttonInner: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  buttonText: { fontSize: 17, fontWeight: "600" },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, marginLeft: 4 },
  input: {
    fontSize: 17,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: 11,
  },
  fieldNote: { fontSize: 13, marginLeft: 4 },
  segmented: {
    flexDirection: "row",
    borderRadius: 9,
    padding: 2,
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.md,
  },
  segment: {
    flex: 1,
    minHeight: 32,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  segmentText: { fontSize: 13 },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  pillText: { fontSize: 12, fontWeight: "600" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: SPACING.xl,
    minHeight: 240,
  },
  message: {
    alignItems: "center",
    gap: SPACING.md,
    padding: SPACING.xl,
    marginTop: SPACING.xl * 2,
  },
  messageTitle: { fontSize: 20, fontWeight: "600", textAlign: "center" },
  messageBody: { fontSize: 15, textAlign: "center", lineHeight: 21 },
})
