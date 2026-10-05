"use client"

import { Loader2, Save } from "lucide-react"

import { FormErrorAlert, useFormAction } from "@/components/profiles/form-kit"
import { Button } from "@/components/ui/button"
import { updateNotificationPrefsAction } from "@/lib/notifications/actions"
import { NOTIFICATION_TYPE_LABELS, type NotificationType } from "@/lib/notifications/types"

export type NotificationPrefView = { type: NotificationType; email: boolean; inApp: boolean }

/** A row per notification type with an email and an in-app switch (native checkboxes). */
export function NotificationPrefsForm({ prefs }: { prefs: readonly NotificationPrefView[] }) {
  const form = useFormAction(updateNotificationPrefsAction)
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
    <form action={form.formAction} className="space-y-6">
      {form.error ? <FormErrorAlert message={form.error.error} /> : null}
      <ul className="divide-y rounded-xl border bg-card shadow-xs">
        {prefs.map((pref) => {
          const label = NOTIFICATION_TYPE_LABELS[pref.type]
          return (
            <li
              key={pref.type}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="text-sm font-medium" id={`pref-${pref.type}`}>
                {label}
              </span>
              <div className="flex gap-6" role="group" aria-labelledby={`pref-${pref.type}`}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="email"
                    value={pref.type}
                    defaultChecked={emailChecked.has(pref.type)}
                    className="size-4 accent-primary"
                  />
                  Email
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="inApp"
                    value={pref.type}
                    defaultChecked={inAppChecked.has(pref.type)}
                    className="size-4 accent-primary"
                  />
                  In the app
                </label>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button type="submit" disabled={form.pending} className="w-full sm:w-auto">
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
      </div>
    </form>
  )
}
