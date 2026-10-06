import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { CollabHeader } from "@/components/collabs/collab-header"
import { ThreadPanel } from "@/components/messages/thread-panel"
import { canViewCollab, canViewThread } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { loadCollabSummary } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"
import { loadThreadAccessByParent } from "@/lib/threads/access"

export const metadata: Metadata = { title: "Messages" }

type Props = { params: Promise<{ id: string }> }

/**
 * The collab's conversation (§12 `/app/collabs/[id]/messages`): its thread, rendered by the shared
 * `ThreadPanel` (Markdown through the sanitizer, attachments through the access-checked route, the
 * composer while the collab has not ended). Members and admins (read-only) only; anyone else gets
 * a 404.
 */
export default async function CollabMessagesPage({ params }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const collab = await loadCollabSummary(db, id)
  if (!collab || !canViewCollab(user, collab)) notFound()
  const thread = await loadThreadAccessByParent(db, { kind: "collab", id: collab.id })
  if (!thread || !canViewThread(user, thread)) notFound()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <CollabHeader collab={collab} viewerId={user.id} section="messages" />
      <section aria-labelledby="collab-messages" className="space-y-3">
        <h2 id="collab-messages" className="sr-only">
          Messages
        </h2>
        <ThreadPanel
          db={db}
          thread={thread}
          viewer={user}
          closedNote="This collab has ended, so its conversation is read-only."
        />
      </section>
    </div>
  )
}
