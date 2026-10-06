import { z } from "zod"

import {
  MATCH_FEATURES,
  MATCHING_TARGETS,
  type MatchFeatures,
  type MatchingModel,
} from "@/lib/db/schema/types"

import { predict } from "./logistic"

/**
 * `matching_config.model` for `kind = 'logistic'` (CLAUDE.md §19.38): parsed with Zod wherever it
 * is read, so a broken row fails loudly instead of ranking with nonsense. Pure and client-safe.
 */

const perFeature = z.object(
  Object.fromEntries(MATCH_FEATURES.map((feature) => [feature, z.number().finite()])) as Record<
    (typeof MATCH_FEATURES)[number],
    z.ZodNumber
  >,
)

const logisticParamsSchema = z.object({
  intercept: z.number().finite(),
  coefficients: perFeature,
  means: perFeature,
  stds: perFeature.refine((stds) => Object.values(stds).every((value) => value >= 0), {
    message: "stds must be non-negative",
  }),
})

export const matchingModelSchema = z
  .object({
    kind: z.literal("logistic"),
    v: z.literal(1),
    scoreTarget: z.enum(MATCHING_TARGETS),
    l2: z.number().finite().min(0),
    targets: z.object({
      accepted: logisticParamsSchema.nullable(),
      sale: logisticParamsSchema.nullable(),
    }),
  })
  .refine((model) => model.targets[model.scoreTarget] !== null, {
    message: "The ranking target has no fitted model",
  }) satisfies z.ZodType<MatchingModel>

/** The ranking score of a v1 model: P(`scoreTarget`), in 0–1, rounded like `matches.score`. */
export function scoreWithModel(model: MatchingModel, features: MatchFeatures): number {
  const params = model.targets[model.scoreTarget]
  if (!params) return 0
  const p = predict(params, features)
  return Math.round(Math.min(1, Math.max(0, p)) * 1_000_000) / 1_000_000
}
