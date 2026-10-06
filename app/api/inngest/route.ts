import type { NextRequest } from "next/server"
import { serve } from "inngest/next"

import { inngest } from "@/inngest/client"
import { functions } from "@/inngest/functions"
import { isFake } from "@/lib/env"

/**
 * Inngest endpoint (§3, §13): Inngest Cloud (or a local dev server with INNGEST_DEV=1) syncs and
 * invokes our functions here; requests are verified with INNGEST_SIGNING_KEY. When jobs are fake
 * they run inline (`lib/jobs/enqueue.ts`) and this route answers 404.
 */

const handler = serve({ client: inngest, functions })

type InngestHandler = (request: NextRequest, context: unknown) => Promise<Response>

function onlyWhenLive(handle: InngestHandler): InngestHandler {
  return async (request, context) => {
    let live = false
    try {
      live = !isFake("jobs")
    } catch {
      live = false
    }
    return live ? handle(request, context) : new Response("Not Found", { status: 404 })
  }
}

export const GET = onlyWhenLive(handler.GET)
export const POST = onlyWhenLive(handler.POST)
export const PUT = onlyWhenLive(handler.PUT)
