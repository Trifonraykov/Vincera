import {
  meSchema,
  requestCodeOutput,
  signOutOutput,
  verifyCodeOutput,
  type Me,
} from "@shared/schemas"
import * as Device from "expo-device"
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { api, ApiError, setApiToken, setUnauthorizedHandler } from "./api"
import { clearToken, readToken, writeToken } from "./token-store"

/**
 * Who is signed in. The bearer token is read from the Keychain at launch and checked with `/me`;
 * a 401 anywhere signs the app out (the session expired, or "Sign out everywhere" on the web).
 */

type AuthState =
  | { status: "loading"; me: null }
  | { status: "signedOut"; me: null }
  | { status: "signedIn"; me: Me }

type AuthContextValue = AuthState & {
  requestCode: (email: string, name?: string) => Promise<void>
  verifyCode: (email: string, code: string, name?: string) => Promise<void>
  signOut: () => Promise<void>
  refreshMe: () => Promise<void>
  setMe: (me: Me) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading", me: null })

  const forget = useCallback(async () => {
    setApiToken(null)
    await clearToken().catch(() => undefined)
    setState({ status: "signedOut", me: null })
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => void forget())
    let cancelled = false
    void (async () => {
      const token = await readToken().catch(() => null)
      if (!token) {
        if (!cancelled) setState({ status: "signedOut", me: null })
        return
      }
      setApiToken(token)
      try {
        const me = await api(meSchema, "GET", "/me")
        if (!cancelled) setState({ status: "signedIn", me })
      } catch (error) {
        // Offline at launch: keep the token and let the person retry from sign-in.
        if (error instanceof ApiError && error.status === 401) await forget()
        else if (!cancelled) setState({ status: "signedOut", me: null })
      }
    })()
    return () => {
      cancelled = true
      setUnauthorizedHandler(null)
    }
  }, [forget])

  const requestCode = useCallback(async (email: string, name?: string) => {
    await api(requestCodeOutput, "POST", "/auth/code", { email, name: name || undefined })
  }, [])

  const verifyCode = useCallback(async (email: string, code: string, name?: string) => {
    const result = await api(verifyCodeOutput, "POST", "/auth/verify", {
      email,
      code,
      name: name || undefined,
      deviceName: Device.deviceName ?? Device.modelName ?? undefined,
    })
    await writeToken(result.token)
    setApiToken(result.token)
    setState({ status: "signedIn", me: result.me })
  }, [])

  const signOut = useCallback(async () => {
    await api(signOutOutput, "POST", "/auth/sign-out").catch(() => undefined)
    await forget()
  }, [forget])

  const refreshMe = useCallback(async () => {
    const me = await api(meSchema, "GET", "/me")
    setState({ status: "signedIn", me })
  }, [])

  const setMe = useCallback((me: Me) => setState({ status: "signedIn", me }), [])

  const value = useMemo(
    () => ({ ...state, requestCode, verifyCode, signOut, refreshMe, setMe }),
    [state, requestCode, verifyCode, signOut, refreshMe, setMe],
  )
  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthContextValue {
  const value = use(AuthContext)
  if (!value) throw new Error("useAuth outside AuthProvider")
  return value
}

/** The signed-in person (screens behind the sign-in guard only). */
export function useMe(): Me {
  const auth = useAuth()
  if (auth.status !== "signedIn") throw new Error("useMe while signed out")
  return auth.me
}
