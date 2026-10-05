import { appIconResponse, isPwaIconFile, PWA_ICONS } from "@/lib/pwa/app-icon"

/** PNG icons for the web app manifest (app/manifest.ts), rendered once at build time. */
export const dynamic = "force-static"
export const dynamicParams = false

export function generateStaticParams() {
  return Object.keys(PWA_ICONS).map((file) => ({ file }))
}

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params
  if (!isPwaIconFile(file)) return new Response("Not found", { status: 404 })
  const icon = PWA_ICONS[file]
  return appIconResponse(icon.size, icon.markShare)
}
