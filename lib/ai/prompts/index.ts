/**
 * Prompt registry (§7.3). Every Claude prompt lives in this folder as a versioned definition.
 *
 * Versioning rules
 * - One file per use (`audience-summary.ts`, `idea-brief.ts`, `match-explanation.ts`,
 *   `launch-kit.ts`), each exporting definitions made with `definePrompt`.
 * - `version` is `<use>@v<n>`. Any change to the system text, the rendered prompt or the output
 *   schema that could change outputs gets a new version: copy the definition, bump `n`, and point
 *   the caller at it. Keep old versions while stored outputs reference them.
 * - The version is passed to `generateStructured` / `generateText`, stored next to every output
 *   (`prompt_version`) and sent with the `ai.generated` event, so outputs and acceptance rates can
 *   be compared per version.
 * - Prompts take typed input and must never include secrets or tokens. Send only the fields the
 *   task needs; user emails and message bodies stay out unless the use requires them.
 * - Every definition provides `fake(input)`: a realistic, deterministic output built from the
 *   input (it must pass the output schema). Callers pass `fakeOutput: () => prompt.fake?.(input)`
 *   to `generateStructured` / `generateText`, so the fake AI service (§19.3) shows sensible text
 *   in local runs and demos instead of schema-shaped placeholders.
 *
 * The actual prompts arrive with their features (Phases 1, 2 and 4).
 */

export const AI_USES = [
  "audience_summary",
  "idea_brief",
  "match_explanation",
  "launch_kit",
  "listing_hook",
] as const

export type AiUse = (typeof AI_USES)[number]

export type PromptDefinition<Input> = {
  use: AiUse
  /** `<use>@v<n>`, e.g. `audience_summary@v1`. */
  version: string
  system: string
  render: (input: Input) => string
  /** Realistic deterministic output for the fake AI service (see the rules above). */
  fake?: (input: Input) => unknown
}

const VERSION_PATTERN = /^([a-z_]+)@v([1-9][0-9]*)$/

/** Declare a prompt. Throws at module load if the version does not follow the rules above. */
export function definePrompt<Input>(definition: PromptDefinition<Input>): PromptDefinition<Input> {
  const match = VERSION_PATTERN.exec(definition.version)
  if (!match || match[1] !== definition.use) {
    throw new Error(
      `Prompt version "${definition.version}" must look like "${definition.use}@v<n>"`,
    )
  }
  return definition
}
