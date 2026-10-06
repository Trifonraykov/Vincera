import { useFocusEffect } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"

import { errorMessage } from "./api"

/**
 * Load a screen's data: on first focus and every time the screen comes back into view (so a
 * change made on a pushed screen or a sheet shows when you return), plus pull to refresh. `key`
 * names what is loaded (an id, a tab): a new key loads again.
 */
export function useApi<T>(load: () => Promise<T>, key = "") {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  const run = useCallback(async (mode: "focus" | "pull") => {
    if (mode === "pull") setRefreshing(true)
    try {
      setData(await loadRef.current())
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      if (mode === "pull") setRefreshing(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      void run("focus")
      // `key` is listed on purpose: a new id or tab must load again while the screen stays focused.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [run, key]),
  )

  return {
    data,
    error,
    loading: data === null && error === null,
    refreshing,
    refresh: () => run("pull"),
    reload: () => run("focus"),
    setData,
  }
}
