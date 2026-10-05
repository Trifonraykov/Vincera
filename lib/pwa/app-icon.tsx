import { ImageResponse } from "next/og"

/**
 * The app icon as a PNG (home screen, app switcher, splash): the logo mark (components/shared/
 * logo.tsx, app/icon.svg) in its dark colours on a dark tile. Drawn with plain boxes so Satori
 * needs no font. `markShare` is the part of the tile the mark spans: maskable icons keep it inside
 * the 80% safe zone that launchers may crop to a circle.
 */

export const APP_ICON_BACKGROUND = "#171717"

export const PWA_ICONS = {
  "icon-192.png": { size: 192, markShare: 0.72, purpose: "any" },
  "icon-512.png": { size: 512, markShare: 0.72, purpose: "any" },
  "maskable-512.png": { size: 512, markShare: 0.56, purpose: "maskable" },
} as const

export type PwaIconFile = keyof typeof PWA_ICONS

export function isPwaIconFile(file: string): file is PwaIconFile {
  return Object.hasOwn(PWA_ICONS, file)
}

export function appIconResponse(size: number, markShare: number): ImageResponse {
  // The mark lives on a 24-unit grid (see app/icon.svg).
  const unit = (size * markShare) / 24
  const offset = (size * (1 - markShare)) / 2
  const box = (x: number, y: number, side: number) => ({
    position: "absolute" as const,
    left: offset + x * unit,
    top: offset + y * unit,
    width: side * unit,
    height: side * unit,
  })
  const stroke = 1.5

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: APP_ICON_BACKGROUND,
      }}
    >
      <div style={{ ...box(2, 2, 13), borderRadius: 3.5 * unit, background: "#fafafa" }} />
      {/* SVG strokes straddle the edge, so the bordered box grows by half a stroke each side. */}
      <div
        style={{
          ...box(9 - stroke / 2, 9 - stroke / 2, 13 + stroke),
          borderRadius: (3.5 + stroke / 2) * unit,
          background: "#404040",
          border: `${stroke * unit}px solid #fafafa`,
        }}
      />
    </div>,
    { width: size, height: size },
  )
}
