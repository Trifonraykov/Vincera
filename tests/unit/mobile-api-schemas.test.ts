import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  agreementStatusEnum,
  availabilityEnum,
  collabRoleEnum,
  collabStageEnum,
  dealPreferenceEnum,
  ideaStatusEnum,
  matchStatusEnum,
  orderStatusEnum,
  productFormatEnum,
  productSourceEnum,
  productStageEnum,
  productStatusEnum,
  proposalStatusEnum,
  sizeTierEnum,
  socialProviderEnum,
  targetTypeEnum,
  threadKindEnum,
  userRoleEnum,
} from "@/lib/db/schema"
import { MATCH_FEATURES } from "@/lib/db/schema/types"
import * as wire from "@/lib/mobile-api/schemas"
import { bearerToken } from "@/lib/mobile-api/sessions"
import { PROPOSAL_TABS } from "@/lib/proposals/display"
import { SUPPLY_FILTERS } from "@/lib/supply/lifecycle"

/**
 * The mobile API's wire contract (lib/mobile-api/schemas.ts, CLAUDE.md §19.44) copies the
 * database enums so the iPhone app can bundle it without server code. These fail when a copy
 * drifts, and keep the file free of imports Metro could not resolve.
 */

describe("mobile API schemas", () => {
  it("copies every enum exactly", () => {
    const pairs: [readonly string[], readonly string[]][] = [
      [wire.USER_ROLE_VALUES, userRoleEnum.enumValues],
      [wire.PRODUCT_SOURCE_VALUES, productSourceEnum.enumValues],
      [wire.SIZE_TIER_VALUES, sizeTierEnum.enumValues],
      [wire.AVAILABILITY_VALUES, availabilityEnum.enumValues],
      [wire.DEAL_PREFERENCE_VALUES, dealPreferenceEnum.enumValues],
      [wire.PRODUCT_FORMAT_VALUES, productFormatEnum.enumValues],
      [wire.PRODUCT_STAGE_VALUES, productStageEnum.enumValues],
      [wire.IDEA_STATUS_VALUES, ideaStatusEnum.enumValues],
      [wire.PRODUCT_STATUS_VALUES, productStatusEnum.enumValues],
      [wire.TARGET_TYPE_VALUES, targetTypeEnum.enumValues],
      [wire.MATCH_STATUS_VALUES, matchStatusEnum.enumValues],
      [wire.PROPOSAL_STATUS_VALUES, proposalStatusEnum.enumValues],
      [wire.COLLAB_STAGE_VALUES, collabStageEnum.enumValues],
      [wire.COLLAB_ROLE_VALUES, collabRoleEnum.enumValues],
      [wire.AGREEMENT_STATUS_VALUES, agreementStatusEnum.enumValues],
      [wire.THREAD_KIND_VALUES, threadKindEnum.enumValues],
      [wire.ORDER_STATUS_VALUES, orderStatusEnum.enumValues],
      [wire.SOCIAL_PROVIDER_VALUES, socialProviderEnum.enumValues],
      [wire.MATCH_FEATURE_VALUES, MATCH_FEATURES],
      [wire.PROPOSAL_TAB_VALUES, PROPOSAL_TABS],
      [wire.SUPPLY_FILTER_VALUES, SUPPLY_FILTERS],
    ]
    for (const [copy, source] of pairs) expect([...copy]).toEqual([...source])
  })

  it("imports nothing but zod", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/mobile-api/schemas.ts"), "utf8")
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
    expect(imports).toEqual(["zod"])
  })

  it("reads only well-formed bearer tokens", () => {
    const token = `vmb_${"A".repeat(43)}`
    expect(bearerToken(new Headers({ authorization: `Bearer ${token}` }))).toBe(token)
    expect(bearerToken(new Headers({ authorization: `bearer ${token}` }))).toBe(token)
    expect(bearerToken(new Headers({ authorization: `Basic ${token}` }))).toBeNull()
    expect(bearerToken(new Headers({ authorization: "Bearer vmb_short" }))).toBeNull()
    expect(bearerToken(new Headers())).toBeNull()
  })

  it("describes dates as ISO strings and money as integers", () => {
    expect(
      wire.ideaListItemSchema.safeParse({
        id: "0199a9c0-0000-7000-8000-000000000000",
        title: "x",
        format: "app",
        targetPriceCents: 9.5,
        currency: "eur",
        topics: [],
        status: "open",
        publishedAt: null,
        updatedAt: "2026-10-05T12:00:00.000Z",
      }).success,
    ).toBe(false)
  })
})
