import { TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

/** Banner for legal texts that are not final (§18.2: pending review by an EU lawyer). */
export function DraftNotice() {
  return (
    <Alert>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Draft — pending legal review</AlertTitle>
      <AlertDescription>
        This text is a working draft and is not yet legally binding. It will be replaced by the
        reviewed version before any real money flows through the platform.
      </AlertDescription>
    </Alert>
  )
}
