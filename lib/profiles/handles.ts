import "server-only"

import { randomInt } from "node:crypto"

import { and, eq, inArray, notExists } from "drizzle-orm"

import { ActionError } from "@/lib/actions/errors"
import type { DbOrTx } from "@/lib/db/client"
import { builderProfiles, creatorProfiles, handles } from "@/lib/db/schema"

import { RESERVED_HANDLES } from "./fields"
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, HANDLE_REGEX } from "./handle-format"

/**
 * The handle registry (§4 "unique across creators and builders"; CLAUDE.md §19.5): `handles` maps
 * a handle to the one user who owns it. A user's creator and builder profiles may share a handle
 * or use two different ones. Profiles reference (handle, user_id), so a profile can only point at
 * a handle its own user owns.
 */

/** The handle belongs to someone else. */
export class HandleTakenError extends ActionError {
  constructor() {
    const message = "That handle is taken. Try another one."
    super(message, { fieldErrors: { handle: [message] } })
    this.name = "HandleTakenError"
  }
}

/**
 * Make `handle` belong to `userId`: insert it, or confirm the user already owns it. Throws
 * `HandleTakenError` when another user holds it. Safe under concurrency: of two users claiming the
 * same handle, the insert of one wins and the other gets the error. Pass the transaction that
 * then points a profile at the handle.
 */
export async function claimHandle(tx: DbOrTx, userId: string, handle: string): Promise<void> {
  const inserted = await tx
    .insert(handles)
    .values({ handle, userId })
    .onConflictDoNothing({ target: handles.handle })
    .returning({ handle: handles.handle })
  if (inserted.length > 0) return
  const [owner] = await tx
    .select({ userId: handles.userId })
    .from(handles)
    .where(eq(handles.handle, handle))
    .limit(1)
  if (!owner || owner.userId !== userId) throw new HandleTakenError()
}

/**
 * Delete a handle of `userId` that neither of their profiles uses any more (after a rename), so
 * someone else can take it. A handle still in use is left alone.
 */
export async function releaseUnusedHandle(
  tx: DbOrTx,
  userId: string,
  handle: string,
): Promise<boolean> {
  const deleted = await tx
    .delete(handles)
    .where(
      and(
        eq(handles.handle, handle),
        eq(handles.userId, userId),
        notExists(
          tx
            .select({ id: creatorProfiles.id })
            .from(creatorProfiles)
            .where(eq(creatorProfiles.handle, handles.handle)),
        ),
        notExists(
          tx
            .select({ id: builderProfiles.id })
            .from(builderProfiles)
            .where(eq(builderProfiles.handle, handles.handle)),
        ),
      ),
    )
    .returning({ handle: handles.handle })
  return deleted.length > 0
}

/** The handles a user owns (normally one; two when their profiles use different handles). */
export async function handlesOfUser(database: DbOrTx, userId: string): Promise<string[]> {
  const rows = await database
    .select({ handle: handles.handle })
    .from(handles)
    .where(eq(handles.userId, userId))
  return rows.map((row) => row.handle)
}

/** "Ada Lovelace" / "ada.lovelace@x" → "ada_lovelace" (may be too short or empty). */
export function handleBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, HANDLE_MAX_LENGTH - 5)
}

/**
 * A handle to prefill the profile form with: the one the user already owns (their other profile),
 * else one derived from their name or email that nobody has. Only a suggestion; the form checks
 * again on submit.
 */
export async function suggestHandle(
  database: DbOrTx,
  user: { id: string; name: string | null; email: string | null },
): Promise<string> {
  const owned = await handlesOfUser(database, user.id)
  if (owned[0]) return owned[0]

  const sources = [user.name ?? "", (user.email ?? "").split("@")[0] ?? ""]
  let base = sources.map(handleBase).find((value) => value.length >= HANDLE_MIN_LENGTH) ?? ""
  if (base.length < HANDLE_MIN_LENGTH) base = "maker"

  const candidates = [base, ...Array.from({ length: 4 }, () => `${base}_${randomInt(10, 9999)}`)]
  const valid = candidates.filter(
    (candidate) => HANDLE_REGEX.test(candidate) && !RESERVED_HANDLES.has(candidate),
  )
  const taken = new Set(
    (
      await database
        .select({ handle: handles.handle })
        .from(handles)
        .where(inArray(handles.handle, valid))
    ).map((row) => row.handle),
  )
  return valid.find((candidate) => !taken.has(candidate)) ?? ""
}
