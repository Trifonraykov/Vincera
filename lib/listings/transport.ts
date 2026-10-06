import "server-only"

import { isFake } from "@/lib/env"
import { liveNetTransport } from "@/lib/net/live-transport"
import type { NetTransport } from "@/lib/net/safe-fetch"

import { createFakeInternet } from "./fake/internet"

/**
 * The network listing imports use (CLAUDE.md §19.3, §19.45): the real one, or the recorded fake
 * internet when `FAKE_SERVICES` names `appstore` / `web` (or `all`). Both go through `safeFetch`.
 */
export function listingTransport(service: "appstore" | "web"): NetTransport {
  return isFake(service) ? createFakeInternet() : liveNetTransport
}
