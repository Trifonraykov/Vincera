import { CircleCheck, Download, FileSignature, ShieldCheck, Wallet } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { AgreementDocument } from "@/components/collabs/agreement-document"
import { CollabHeader } from "@/components/collabs/collab-header"
import { MemberList } from "@/components/collabs/member-list"
import { SignAgreementForm } from "@/components/collabs/sign-agreement-form"
import { SyncRefresher } from "@/components/social/sync-refresher"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { shortHash } from "@/lib/agreements/fields"
import { loadActiveAgreement } from "@/lib/agreements/queries"
import { agreementDate } from "@/lib/agreements/template-v1"
import { canSignAgreement, canViewCollab } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { now } from "@/lib/clock"
import { loadCollabSummary, loadPayoutsReadiness } from "@/lib/collabs/queries"
import { getDb } from "@/lib/db/client"
import { formatExact } from "@/lib/proposals/display"

export const metadata: Metadata = { title: "Agreement" }

type Props = { params: Promise<{ id: string }> }

const SIGNING_AS = { creator: "the Creator", builder: "the Builder" } as const

/** How long after the last signature the page keeps checking for the PDF. */
const PDF_WAIT_MS = 10 * 60 * 1000

/**
 * The collab's agreement (§12 `/app/collabs/[id]/agreement`): the stored text both members sign
 * (template v1 filled with the deal's terms, marked "draft — pending legal review", §18.2), who has
 * signed, whether each member can be paid, and the signing form. Signing needs a typed full name
 * and **both** members payouts-ready; otherwise the page explains who still has to set up payouts
 * and links to Settings → Payouts. Once both signed: the date, and the signed PDF to download.
 * Members and admins only (`canViewCollab`); anyone else gets a 404.
 */
export default async function CollabAgreementPage({ params }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const collab = await loadCollabSummary(db, id)
  if (!collab || !canViewCollab(user, collab)) notFound()

  const agreement = await loadActiveAgreement(db, collab.id)
  const readiness = await loadPayoutsReadiness(db, collab.memberUserIds)
  const self = collab.members.find((member) => member.userId === user.id) ?? null
  const signatures = new Map(
    (agreement?.signatures ?? []).map((signature) => [signature.userId, signature]),
  )
  const viewerSigned = signatures.has(user.id)
  const canSign =
    agreement !== null &&
    collab.stage === "agreement" &&
    canSignAgreement(user, {
      memberUserIds: collab.memberUserIds,
      status: agreement.status,
      signedUserIds: [...signatures.keys()],
    })
  const notReady = collab.members.filter((member) => !readiness.get(member.userId))
  const selfNotReady = notReady.some((member) => member.userId === user.id)
  const othersNotReady = notReady.filter((member) => member.userId !== user.id)
  const waitingFor = collab.members.filter(
    (member) => member.userId !== user.id && !signatures.has(member.userId),
  )
  const pdfPending =
    agreement?.status === "signed" &&
    agreement.pdfStorageKey === null &&
    agreement.completedAt !== null &&
    now().getTime() - agreement.completedAt.getTime() < PDF_WAIT_MS

  const blocked =
    canSign && notReady.length > 0 ? (
      <Alert>
        <Wallet aria-hidden="true" />
        <AlertTitle>
          {selfNotReady ? "Set up payouts before you sign" : "Waiting for payouts to be set up"}
        </AlertTitle>
        <AlertDescription>
          <p>
            You can both sign once you can both be paid for every sale.{" "}
            {othersNotReady.length > 0
              ? `${othersNotReady.map((member) => member.name).join(" and ")} still ${othersNotReady.length === 1 ? "needs" : "need"} to set up payouts.`
              : null}
          </p>
          {selfNotReady ? (
            <Button asChild size="sm" className="mt-2 h-11 sm:h-8">
              <Link href="/app/settings/payouts">Set up payouts</Link>
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    ) : null

  const document = agreement ? (
    <section
      aria-labelledby="agreement-text"
      className="space-y-3 rounded-xl border bg-card p-4 shadow-xs sm:p-6"
    >
      <h2 id="agreement-text" className="sr-only">
        Agreement text
      </h2>
      <AgreementDocument body={agreement.renderedBody} />
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        <ShieldCheck className="size-4" aria-hidden="true" />
        <span>
          Fingerprint (SHA-256){" "}
          <code className="font-mono" title={agreement.bodyHash}>
            {shortHash(agreement.bodyHash)}
          </code>{" "}
          · template {agreement.templateVersion} · generated {formatExact(agreement.createdAt)}
        </span>
      </p>
    </section>
  ) : null

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <CollabHeader collab={collab} viewerId={user.id} section="agreement" />

      {!agreement ? (
        <Alert>
          <FileSignature aria-hidden="true" />
          <AlertTitle>No agreement yet</AlertTitle>
          <AlertDescription>
            This collab has no agreement in force. If you think that&apos;s wrong, contact support.
          </AlertDescription>
        </Alert>
      ) : agreement.status === "signed" ? (
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>Signed by both of you</AlertTitle>
          <AlertDescription>
            <p>
              The agreement was completed on{" "}
              {agreement.completedAt ? agreementDate(agreement.completedAt) : "—"}. Your copy was
              emailed to you both.
            </p>
            {agreement.pdfStorageKey ? (
              <Button asChild size="sm" className="mt-2 h-11 sm:h-8">
                <a href={`/api/agreements/${agreement.id}/pdf`}>
                  <Download aria-hidden="true" />
                  Download the signed PDF
                </a>
              </Button>
            ) : pdfPending ? (
              <SyncRefresher
                message="Preparing the signed PDF…"
                intervalMs={3000}
                maxAttempts={40}
              />
            ) : (
              <p>The signed PDF is still being prepared. Check back in a few minutes.</p>
            )}
          </AlertDescription>
        </Alert>
      ) : viewerSigned ? (
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>You signed</AlertTitle>
          <AlertDescription>
            Waiting for{" "}
            {waitingFor.map((member) => member.name).join(" and ") || "your collaborator"} to sign.
            We&apos;ll email you both the signed PDF once they have.
          </AlertDescription>
        </Alert>
      ) : canSign ? (
        <p className="text-sm text-muted-foreground">
          Read the agreement, then sign at the bottom by typing your full name. Work starts once you
          have both signed.
        </p>
      ) : collab.stage === "ended" ? (
        <Alert>
          <FileSignature aria-hidden="true" />
          <AlertTitle>This collab has ended</AlertTitle>
          <AlertDescription>Its agreement can no longer be signed.</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="signatures-heading" className="space-y-3">
        <h2 id="signatures-heading" className="font-semibold">
          Signatures
        </h2>
        <MemberList
          members={collab.members}
          viewerId={user.id}
          signatures={signatures}
          payoutsReady={agreement?.status === "awaiting_signatures" ? readiness : undefined}
        />
      </section>

      {canSign && agreement && self ? (
        <SignAgreementForm
          agreementId={agreement.id}
          bodyHash={agreement.bodyHash}
          signingAs={SIGNING_AS[self.role]}
          blocked={blocked}
        >
          {document}
        </SignAgreementForm>
      ) : (
        document
      )}
    </div>
  )
}
