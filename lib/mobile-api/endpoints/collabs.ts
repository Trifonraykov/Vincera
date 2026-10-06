import "server-only"

import { eq } from "drizzle-orm"
import { z } from "zod"

import { ActionError } from "@/lib/actions/errors"
import { loadActiveAgreement } from "@/lib/agreements/queries"
import { AGREEMENT_MESSAGES, signAgreement } from "@/lib/agreements/sign"
import {
  canManageOwnAccount,
  canSignAgreement,
  canViewCollab,
  canWorkInCollab,
} from "@/lib/auth/authz"
import type { AuthUser } from "@/lib/auth/user"
import { collabNextStep, matchesCollabFilter, parseCollabFilter } from "@/lib/collabs/display"
import {
  countOpenTasks,
  listCollabsForUser,
  loadCollabAccess,
  loadCollabSummary,
  loadPayoutsReadiness,
  type CollabSummary,
} from "@/lib/collabs/queries"
import type { Db } from "@/lib/db/client"
import { agreementSignatures, agreements, collabMembers } from "@/lib/db/schema"
import { clientIp } from "@/lib/ratelimit"
import { taskFieldsSchema } from "@/lib/tasks/fields"
import { findTaskCollabId, listCollabTasks } from "@/lib/tasks/queries"
import {
  createTask,
  deleteTask,
  moveTask,
  setTaskDone,
  TASK_ERRORS,
  updateTask,
} from "@/lib/tasks/service"

import { revalidateApp } from "../context"
import { forbidden, MobileApiError } from "../errors"
import { endpoint, parseForm, uuidParam, type Endpoint } from "../router"
import {
  agreementOutput,
  collabDetailSchema,
  collabListOutput,
  okSchema,
  signAgreementInput,
  signAgreementOutput,
  taskChangedOutput,
  taskDoneInput,
  taskFormInput,
  taskListOutput,
  taskMoveInput,
} from "../schemas"

/**
 * Collabs, tasks and the agreement (§12 `/app/collabs/*`; CLAUDE.md §19.28). Members and admins
 * (read-only) see a collab (`canViewCollab`); anyone else gets a 404. Task changes and signing go
 * through lib/tasks/service.ts and lib/agreements/sign.ts, which lock, re-check, touch the
 * collab's activity and write the events, exactly as for the web.
 */

const collabNotFound = (message: string = TASK_ERRORS.collabNotFound) =>
  new MobileApiError(404, "not_found", message)

async function viewableCollab(db: Db, user: AuthUser, collabId: string): Promise<CollabSummary> {
  const collab = await loadCollabSummary(db, collabId)
  if (!collab || !canViewCollab(user, collab)) throw collabNotFound()
  return collab
}

/** The web's task `authorizeCollab` (lib/tasks/actions.ts). */
async function authorizeWork(
  db: Db,
  user: AuthUser,
  collabId: string | null,
  notFoundMessage: string,
): Promise<void> {
  const collab = collabId ? await loadCollabAccess(db, collabId) : null
  if (!collab || !collab.memberUserIds.includes(user.id)) throw collabNotFound(notFoundMessage)
  if (collab.stage === "ended") throw new ActionError(TASK_ERRORS.ended)
  if (!canWorkInCollab(user, collab)) throw forbidden()
}

async function authorizeTask(db: Db, user: AuthUser, taskId: string): Promise<void> {
  await authorizeWork(db, user, await findTaskCollabId(db, taskId), TASK_ERRORS.notFound)
}

function signBlockedReason(
  viewerId: string,
  members: CollabSummary["members"],
  readiness: Map<string, boolean>,
): string | null {
  const notReady = members.filter((member) => !readiness.get(member.userId))
  const self = notReady.some((member) => member.userId === viewerId)
  const others = notReady
    .filter((member) => member.userId !== viewerId)
    .map((member) => member.name)
    .join(" and ")
  if (self && others) return AGREEMENT_MESSAGES.payoutsBoth(others)
  if (self) return AGREEMENT_MESSAGES.payoutsSelf
  if (others) return AGREEMENT_MESSAGES.payoutsOther(others)
  return null
}

export const collabEndpoints: Endpoint[] = [
  endpoint({
    method: "GET",
    path: "/collabs",
    auth: "onboarded",
    query: z.object({ stage: z.string().max(20).optional() }),
    output: collabListOutput,
    run: async ({ db, user, query }) => {
      if (!canManageOwnAccount(user)) throw forbidden()
      const filter = parseCollabFilter(query.stage)
      const items = await listCollabsForUser(db, user.id)
      return {
        items: items
          .filter((item) => matchesCollabFilter(item.stage, filter))
          .map((item) => ({ ...item, nextStep: collabNextStep(item) })),
      }
    },
  }),
  endpoint({
    method: "GET",
    path: "/collabs/:id",
    auth: "onboarded",
    output: collabDetailSchema,
    run: async ({ db, user, params }) => {
      const collab = await viewableCollab(db, user, uuidParam(params))
      const [agreement, readiness, taskCounts] = await Promise.all([
        loadActiveAgreement(db, collab.id),
        loadPayoutsReadiness(db, collab.memberUserIds),
        countOpenTasks(db, collab.id),
      ])
      const signed = new Set(agreement?.signatures.map((signature) => signature.userId) ?? [])
      return {
        ...collab,
        members: collab.members.map((member) => ({
          ...member,
          payoutsReady: readiness.get(member.userId) ?? false,
          signed: signed.has(member.userId),
        })),
        scope: agreement?.terms.scope ?? null,
        timelineWeeks: agreement?.terms.timelineWeeks ?? null,
        agreement: agreement
          ? { id: agreement.id, status: agreement.status, signedByViewer: signed.has(user.id) }
          : null,
        openTasks: taskCounts.open,
        canWork: canWorkInCollab(user, collab),
        nextStep: collabNextStep({
          stage: collab.stage,
          agreementStatus: agreement?.status ?? null,
          signedByViewer: signed.has(user.id),
          openTasks: taskCounts.open,
        }),
      }
    },
  }),

  // --- Tasks ---
  endpoint({
    method: "GET",
    path: "/collabs/:id/tasks",
    auth: "onboarded",
    output: taskListOutput,
    run: async ({ db, user, params }) => {
      const collab = await viewableCollab(db, user, uuidParam(params))
      const tasks = await listCollabTasks(db, collab.id)
      return {
        canWork: canWorkInCollab(user, collab),
        members: collab.members,
        open: tasks.open,
        done: tasks.done,
      }
    },
  }),
  endpoint({
    method: "POST",
    path: "/collabs/:id/tasks",
    auth: "onboarded",
    input: taskFormInput,
    output: taskChangedOutput,
    run: async ({ db, user, params, input }) => {
      const collabId = uuidParam(params)
      await authorizeWork(db, user, collabId, TASK_ERRORS.collabNotFound)
      const fields = parseForm(taskFieldsSchema, input)
      const result = await createTask(db, user, { collabId, ...fields })
      revalidateApp()
      return { taskId: result.taskId }
    },
  }),
  endpoint({
    method: "PATCH",
    path: "/tasks/:id",
    auth: "onboarded",
    input: taskFormInput,
    output: taskChangedOutput,
    run: async ({ db, user, params, input }) => {
      const taskId = uuidParam(params)
      await authorizeTask(db, user, taskId)
      const fields = parseForm(taskFieldsSchema, input)
      await updateTask(db, user, { taskId, ...fields })
      revalidateApp()
      return { taskId }
    },
  }),
  endpoint({
    method: "POST",
    path: "/tasks/:id/done",
    auth: "onboarded",
    input: taskDoneInput,
    output: taskChangedOutput,
    run: async ({ db, user, params, input }) => {
      const taskId = uuidParam(params)
      await authorizeTask(db, user, taskId)
      await setTaskDone(db, user, { taskId, done: input.done })
      revalidateApp()
      return { taskId }
    },
  }),
  endpoint({
    method: "POST",
    path: "/tasks/:id/move",
    auth: "onboarded",
    input: taskMoveInput,
    output: taskChangedOutput,
    run: async ({ db, user, params, input }) => {
      const taskId = uuidParam(params)
      await authorizeTask(db, user, taskId)
      await moveTask(db, user, { taskId, direction: input.direction })
      revalidateApp()
      return { taskId }
    },
  }),
  endpoint({
    method: "DELETE",
    path: "/tasks/:id",
    auth: "onboarded",
    output: okSchema,
    run: async ({ db, user, params }) => {
      const taskId = uuidParam(params)
      await authorizeTask(db, user, taskId)
      await deleteTask(db, user, { taskId })
      revalidateApp()
      return { ok: true as const }
    },
  }),

  // --- Agreement ---
  endpoint({
    method: "GET",
    path: "/collabs/:id/agreement",
    auth: "onboarded",
    output: agreementOutput,
    run: async ({ db, user, params }) => {
      const collab = await viewableCollab(db, user, uuidParam(params))
      const agreement = await loadActiveAgreement(db, collab.id)
      if (!agreement) return { agreement: null }
      const readiness = await loadPayoutsReadiness(db, collab.memberUserIds)
      const signedIds = agreement.signatures.map((signature) => signature.userId)
      const eligible =
        collab.stage === "agreement" &&
        canSignAgreement(user, {
          memberUserIds: collab.memberUserIds,
          status: agreement.status,
          signedUserIds: signedIds,
        })
      const blocked = eligible ? signBlockedReason(user.id, collab.members, readiness) : null
      return {
        agreement: {
          ...agreement,
          hasPdf: agreement.pdfStorageKey !== null,
          members: collab.members.map((member) => ({
            ...member,
            payoutsReady: readiness.get(member.userId) ?? false,
            signed: signedIds.includes(member.userId),
          })),
          canSign: eligible && blocked === null,
          blockedReason: blocked,
        },
      }
    },
  }),
  endpoint({
    method: "POST",
    path: "/agreements/:id/sign",
    auth: "onboarded",
    input: signAgreementInput,
    output: signAgreementOutput,
    run: async ({ db, user, params, input, request }) => {
      const agreementId = uuidParam(params)
      // The web's `signAgreementAction.authorize` (lib/agreements/actions.ts).
      const [agreement] = await db
        .select({ collabId: agreements.collabId, status: agreements.status })
        .from(agreements)
        .where(eq(agreements.id, agreementId))
      const notFound = () => new MobileApiError(404, "not_found", AGREEMENT_MESSAGES.notFound)
      if (!agreement) throw notFound()
      const members = await db
        .select({ userId: collabMembers.userId })
        .from(collabMembers)
        .where(eq(collabMembers.collabId, agreement.collabId))
      const memberUserIds = members.map((member) => member.userId)
      if (!memberUserIds.includes(user.id)) throw notFound()
      const signatures = await db
        .select({ userId: agreementSignatures.userId })
        .from(agreementSignatures)
        .where(eq(agreementSignatures.agreementId, agreementId))
      const signedUserIds = signatures.map((signature) => signature.userId)
      if (!signedUserIds.includes(user.id)) {
        if (agreement.status === "terminated") throw new ActionError(AGREEMENT_MESSAGES.terminated)
        if (!canSignAgreement(user, { memberUserIds, status: agreement.status, signedUserIds })) {
          throw forbidden()
        }
      }
      const result = await signAgreement(db, user, {
        agreementId,
        typedName: input.typedName,
        bodyHash: input.bodyHash,
        ip: clientIp(request.headers),
        userAgent: request.headers.get("user-agent"),
      })
      revalidateApp()
      return { completed: result.completed, alreadySigned: result.status === "already_signed" }
    },
  }),
]
