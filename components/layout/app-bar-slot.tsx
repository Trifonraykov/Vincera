"use client"

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

/**
 * The phone app bar's slots (components/layout/app-bar.tsx), for pages to fill.
 *
 * By default the bar shows the menu title of the current path (`shellTitle` in lib/nav.ts) and a
 * back button to the parent page (`shellBackHref`). A page that knows better renders
 * `<AppBarSlot>` anywhere in its tree:
 *
 * ```tsx
 * <AppBarSlot
 *   title={`Collab with @${partner.handle}`}  // replaces the menu title
 *   back="/app/collabs"                         // a path, or null to hide the back button
 *   action={<NewTaskButton />}                   // one compact control, phones only
 * />
 * ```
 *
 * The slot applies after hydration (the server renders the defaults), and the last mounted slot
 * wins. The action shows below `md` only; keep the desktop version in the page's `PageHeader`
 * (hide it there on phones with `hidden md:inline-flex` when it would appear twice). Use an icon
 * button with an `aria-label`, at least 44 px (`size-11`).
 */
export type AppBarOptions = {
  title?: string
  /** A path for the back button, or null to hide it. Undefined keeps the default. */
  back?: string | null
  action?: ReactNode
}

type AppBarContextValue = {
  options: AppBarOptions | null
  set: (id: string, options: AppBarOptions | null) => void
}

const AppBarContext = createContext<AppBarContextValue | null>(null)

/** Holds the slot values; the app shell renders it around the bar and the page. */
export function AppBarProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<{ id: string; options: AppBarOptions }[]>([])

  const set = useCallback((id: string, options: AppBarOptions | null) => {
    setEntries((current) => {
      const others = current.filter((entry) => entry.id !== id)
      return options ? [...others, { id, options }] : others
    })
  }, [])

  const value = useMemo(() => ({ options: entries.at(-1)?.options ?? null, set }), [entries, set])
  return <AppBarContext.Provider value={value}>{children}</AppBarContext.Provider>
}

/** What the current page set (or null), for the bar itself. */
export function useAppBarOptions(): AppBarOptions | null {
  return useContext(AppBarContext)?.options ?? null
}

/** Sets the phone app bar's title, back target and action for as long as it is mounted. */
export function AppBarSlot({ title, back, action }: AppBarOptions) {
  const context = useContext(AppBarContext)
  const id = useId()
  const set = context?.set

  useLayoutEffect(() => {
    if (!set) return
    set(id, { title, back, action })
  }, [set, id, title, back, action])

  useLayoutEffect(() => {
    if (!set) return
    return () => set(id, null)
  }, [set, id])

  return null
}
