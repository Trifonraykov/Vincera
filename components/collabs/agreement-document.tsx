import { parseAgreementBody } from "@/lib/agreements/body"
import { cn } from "@/lib/utils"

/**
 * An agreement's text on a page (§12 "renders the template with a terms snapshot"). It renders the
 * stored text (`rendered_body`, lib/agreements/body.ts), the same text the hash and the PDF use,
 * never a fresh rendering. The title is an `h2` under the page's own `h1`, or left out.
 */
export function AgreementDocument({
  body,
  showTitle = true,
  className,
}: {
  body: string
  showTitle?: boolean
  className?: string
}) {
  const blocks = parseAgreementBody(body)
  return (
    <div className={cn("space-y-3 text-sm leading-relaxed text-pretty", className)}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "title":
            return showTitle ? (
              <h2 key={index} className="text-xl font-semibold tracking-tight">
                {block.text}
              </h2>
            ) : null
          case "heading":
            return (
              <h3 key={index} className="pt-3 text-base font-semibold">
                {block.text}
              </h3>
            )
          case "list":
            return (
              <ul key={index} className="ml-5 list-disc space-y-1">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="break-words">
                    {item}
                  </li>
                ))}
              </ul>
            )
          case "quote":
            return (
              <blockquote
                key={index}
                className="rounded-md border-l-2 bg-muted/60 px-3 py-2 break-words whitespace-pre-wrap"
              >
                {block.text}
              </blockquote>
            )
          case "paragraph":
            return (
              <p key={index} className="break-words whitespace-pre-line">
                {block.text}
              </p>
            )
        }
      })}
    </div>
  )
}
