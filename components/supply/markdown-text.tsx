import "server-only"

import { renderMarkdown } from "@/lib/markdown"
import { cn } from "@/lib/utils"

/**
 * User Markdown (product descriptions, idea problems and evidence), sanitized on render
 * (lib/markdown.ts, §14). The only place supply pages use `dangerouslySetInnerHTML`, and only on
 * `renderMarkdown`'s output. Long words and links wrap, so a pasted URL never widens a phone page.
 */
export function MarkdownText({ source, className }: { source: string; className?: string }) {
  const html = renderMarkdown(source)
  if (!html) return null
  return (
    <div
      className={cn(
        "space-y-3 text-sm leading-relaxed text-pretty [overflow-wrap:anywhere] break-words",
        "[&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4",
        "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_h3]:text-base [&_h3]:font-semibold [&_h4]:font-semibold",
        "[&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
        "[&_hr]:border-border",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
