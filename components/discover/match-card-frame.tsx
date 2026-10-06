"use client"

import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

type MatchCardContextValue = { dismiss: () => void }

const MatchCardContext = createContext<MatchCardContextValue | null>(null)

/** The card's actions use it to hide the card right after a dismissal. */
export function useMatchCard(): MatchCardContextValue | null {
  return useContext(MatchCardContext)
}

/**
 * The list item around a match card (server-rendered content inside). It disappears as soon as the
 * person dismisses the match, before the list re-renders without it.
 */
export function MatchCardFrame({ children, label }: { children: ReactNode; label: string }) {
  const [dismissed, setDismissed] = useState(false)
  const value = useMemo(() => ({ dismiss: () => setDismissed(true) }), [])
  if (dismissed) return null
  return (
    <MatchCardContext.Provider value={value}>
      <li aria-label={label} className="list-none">
        {children}
      </li>
    </MatchCardContext.Provider>
  )
}
