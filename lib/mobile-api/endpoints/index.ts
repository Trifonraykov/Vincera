import "server-only"

import type { AuthHandlers } from "../auth"
import type { Endpoint } from "../router"
import { accountEndpoints } from "./account"
import { authEndpoints } from "./auth"
import { collabEndpoints } from "./collabs"
import { discoverEndpoints } from "./discover"
import { inboxEndpoints } from "./inbox"
import { listingEndpoints } from "./listings"
import { proposalEndpoints } from "./proposals"
import { supplyEndpoints } from "./supply"

/** Every mobile API endpoint (CLAUDE.md §19.44). Tests pass their own Auth.js handlers. */
export function mobileEndpoints(
  options: { authHandlers?: () => Promise<AuthHandlers> } = {},
): Endpoint[] {
  return [
    ...authEndpoints(options),
    ...discoverEndpoints,
    ...supplyEndpoints,
    ...proposalEndpoints,
    ...collabEndpoints,
    ...inboxEndpoints,
    ...accountEndpoints,
    ...listingEndpoints,
  ]
}
