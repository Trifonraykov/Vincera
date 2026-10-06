import { renderMarkdown } from "@/lib/markdown"
import { cn } from "@/lib/utils"

/**
 * User Markdown rendered through `renderMarkdown` (lib/markdown.ts: sanitized, no raw HTML, no
 * images, safe links; §14). The only place messages reach `dangerouslySetInnerHTML`. Server only.
 */
export function MarkdownBody({ source, className }: { source: string; className?: string }) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed break-words",
        "[&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-current/30 [&_blockquote]:pl-3 [&_blockquote]:opacity-90",
        "[&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] dark:[&_code]:bg-white/10",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/10 [&_pre]:p-2 dark:[&_pre]:bg-white/10 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_h3]:mt-2 [&_h3]:font-semibold [&_h4]:mt-2 [&_h4]:font-medium",
        "[&_hr]:my-3 [&_hr]:border-current/20",
        "[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
        "[&>*+*]:mt-2",
        className,
      )}
      // renderMarkdown's output is sanitized (lib/markdown.ts).
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  )
}
