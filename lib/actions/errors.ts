import type { FieldErrors } from "./result"

/**
 * A failure whose message is safe and useful to show to the user (§4). `defineAction` returns its
 * message as the action's error; anything else thrown becomes a generic message. `fieldErrors`
 * (optional) puts messages next to form inputs, e.g. "That handle is taken" on the handle field.
 *
 * Kept in its own dependency-free module (re-exported by `./define-action`) so domain modules can
 * throw it without importing the action machinery, which would create import cycles through
 * lib/auth/session.ts.
 */
export class ActionError extends Error {
  readonly fieldErrors: FieldErrors | undefined

  constructor(message: string, options: { fieldErrors?: FieldErrors } = {}) {
    super(message)
    this.name = "ActionError"
    this.fieldErrors = options.fieldErrors
  }
}
