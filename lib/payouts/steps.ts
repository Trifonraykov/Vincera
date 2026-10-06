/**
 * The part of a job's `step` the payouts area uses (inngest/define.ts `JobStep`): each `run` is
 * memoised by Inngest and retried on its own; inline it just calls the function. Results must be
 * plain JSON (Inngest round-trips them).
 */
export type StepRunner = {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>
}

/** Run every step at once (scripts, tests and callers outside a job). */
export const inlineSteps: StepRunner = { run: async (_id, fn) => fn() }
