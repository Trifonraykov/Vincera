"use client"

import { Loader2, Save } from "lucide-react"

import { FormActions, FormErrorAlert, useFormAction } from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { updateNotificationPrefsAction } from "@/lib/notifications/actions"
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_TYPE_LABELS,
  REQUIRED_EMAIL_TYPES,
  type NotificationType,
} from "@/lib/notifications/types"

export type NotificationPrefView = { type: NotificationType; email: boolean; inApp: boolean }

/**
 * Settings → Notifications: per type, an email and an in-app switch (native checkboxes, each label
 * at least 44 px tall on touch screens), in the catalog's groups (Account, Proposals, Collabs).
 * Save sits in the sticky action bar on phones.
 */
export function NotificationPrefsForm({ prefs }: { prefs: readonly NotificationPrefView[] }) {
  const form = useFormAction(updateNotificationPrefsAction)
  const byType = new Map(prefs.map((pref) => [pref.type, pref]))
  const emailChecked = new Set(
    form.valuesFor(
      "email",
      prefs.filter((p) => p.email).map((p) => p.type),
    ),
  )
  const inAppChecked = new Set(
    form.valuesFor(
      "inApp",
      prefs.filter((p) => p.inApp).map((p) => p.type),
    ),
  )

  return (
    <form action={form.formAction} className="space-y-8">
      {form.error ? <FormErrorAlert message={form.error.error} /> : null}
      {NOTIFICATION_GROUPS.map((group) => {
        const rows = group.types.filter((type) => byType.has(type))
        if (rows.length === 0) return null
        const headingId = `prefs-${group.label.toLowerCase()}`
        return (
          <section key={group.label} aria-labelledby={headingId} className="space-y-3">
            <h2 id={headingId} className="text-sm font-semibold">
              {group.label}
            </h2>
            <ul className="divide-y rounded-xl border bg-card shadow-xs">
              {rows.map((type) => {
                const label = NOTIFICATION_TYPE_LABELS[type]
                const required = REQUIRED_EMAIL_TYPES.includes(type)
                return (
                  <li
                    key={type}
                    className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-sm">
                      <span className="font-medium" id={`pref-${type}`}>
                        {label}
                      </span>
                      {required ? (
                        <span id={`pref-${type}-required`} className="block text-muted-foreground">
                          Always emailed: it carries your signed agreement.
                        </span>
                      ) : null}
                    </span>
                    <div className="flex gap-6" role="group" aria-labelledby={`pref-${type}`}>
                      {required ? (
                        <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground sm:min-h-0">
                          <input
                            type="checkbox"
                            checked
                            disabled
                            readOnly
                            aria-describedby={`pref-${type}-required`}
                            className="size-4 accent-primary"
                          />
                          Email
                        </label>
                      ) : (
                        <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
                          <input
                            type="checkbox"
                            name="email"
                            value={type}
                            defaultChecked={emailChecked.has(type)}
                            className="size-4 accent-primary"
                          />
                          Email
                        </label>
                      )}
                      <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
                        <input
                          type="checkbox"
                          name="inApp"
                          value={type}
                          defaultChecked={inAppChecked.has(type)}
                          className="size-4 accent-primary"
                        />
                        In the app
                      </label>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
      <FormActions className="sm:justify-start">
        <Button type="submit" disabled={form.pending} className="h-11 w-full sm:h-9 sm:w-auto">
          {form.pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          Save preferences
        </Button>
        {form.result?.ok ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saved.
          </p>
        ) : null}
      </FormActions>
    </form>
  )
}
