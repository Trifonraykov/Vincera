import { appIconResponse } from "@/lib/pwa/app-icon"

/** The iOS home-screen icon (`apple-touch-icon`). iOS rounds the corners itself. */
export const size = { width: 180, height: 180 }
export const contentType = "image/png"

export default function AppleIcon() {
  return appIconResponse(size.width, 0.72)
}
