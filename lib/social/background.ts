import "server-only"

import { runInBackground as runJobInBackground } from "@/lib/jobs/background"

/** Background work of the social area (lib/jobs/background.ts, tagged `area: social`). */
export async function runInBackground(label: string, task: () => Promise<unknown>): Promise<void> {
  await runJobInBackground("social", label, task)
}
