/** Same normalisation as Auth.js's email provider, applied to every login method. Client-safe. */
export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase()
}
