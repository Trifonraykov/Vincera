/** State of the magic-link form (`requestMagicLink` with `useActionState`). Client-safe. */
export type MagicLinkState =
  | { status: "idle" }
  | { status: "sent"; email: string }
  | {
      status: "error"
      message: string
      fieldErrors?: { email?: string[]; name?: string[] }
      /** What the user typed, so the form can show it again. */
      values: { email: string; name: string }
    }

export const INITIAL_MAGIC_LINK_STATE: MagicLinkState = { status: "idle" }
