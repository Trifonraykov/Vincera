import { z } from "zod"

/**
 * The launch kit's platforms and output shape (§7.3 use 4), shared by the prompt
 * (./launch-kit.ts, server-only) and the kit page's client component. Client-safe.
 */

export const LAUNCH_KIT_PLATFORMS = ["youtube", "instagram", "tiktok"] as const
export type LaunchKitPlatform = (typeof LAUNCH_KIT_PLATFORMS)[number]
export const LAUNCH_KIT_POSTS_PER_PLATFORM = 3
export const LAUNCH_KIT_POST_MAX = 1200

export const LAUNCH_KIT_PLATFORM_LABELS: Record<
  LaunchKitPlatform,
  { name: string; format: string }
> = {
  youtube: { name: "YouTube", format: "a community post or a video description block" },
  instagram: { name: "Instagram", format: "a caption (link in bio or story link sticker)" },
  tiktok: { name: "TikTok", format: "a short caption plus a 1-line spoken hook" },
}

const postSchema = z.object({
  angle: z
    .string()
    .min(1)
    .max(60)
    .describe("A 1 to 4 word label for the post's angle, e.g. 'Behind the scenes'."),
  text: z
    .string()
    .min(20)
    .max(LAUNCH_KIT_POST_MAX)
    .describe("The post, ready to paste, including the tracked link exactly as given."),
})

export const launchKitOutputSchema = z.object({
  platforms: z
    .array(
      z.object({
        platform: z.enum(LAUNCH_KIT_PLATFORMS),
        posts: z.array(postSchema).min(1).max(LAUNCH_KIT_POSTS_PER_PLATFORM),
      }),
    )
    .min(1)
    .max(LAUNCH_KIT_PLATFORMS.length),
})
export type LaunchKitOutput = z.infer<typeof launchKitOutputSchema>
