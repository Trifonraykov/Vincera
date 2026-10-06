import { Redirect } from "expo-router"

import { useAuth } from "@/lib/auth"

/** The app's entry URL: the Home tab when signed in, else sign-in. */
export default function Index() {
  const auth = useAuth()
  return <Redirect href={auth.status === "signedIn" ? "/(tabs)/(home)/home" : "/sign-in"} />
}
