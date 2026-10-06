import { seedCollabs } from "./collabs"
import { seedMatches } from "./matches"
import { seedPeople } from "./people"
import { seedSupply } from "./supply"
import type { SeedContext, SeedStep } from "./types"

export type { SeedContext, SeedStep } from "./types"

/** The seed steps in order (lib/seed/types.ts). Phase 4 adds `launches` after `collabs`. */
export const SEED_STEPS: readonly SeedStep[] = [seedPeople, seedSupply, seedMatches, seedCollabs]

/** Run every step in order; a failing step stops the seed (later steps depend on earlier ones). */
export async function runSeed(ctx: SeedContext): Promise<void> {
  for (const step of SEED_STEPS) {
    const result = await step.run(ctx)
    ctx.log(
      "created" in result
        ? `  ${step.name}: ${result.created} created`
        : `  ${step.name}: skipped (${result.skipped})`,
    )
  }
}
