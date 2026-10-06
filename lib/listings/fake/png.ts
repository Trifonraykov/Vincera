import { crc32, deflateSync } from "node:zlib"

/**
 * Deterministic placeholder images for the fake App Store and fake web (CLAUDE.md §19.45): real
 * PNG files (so the real sniffing, storage and serving code runs) that look like an app icon, a
 * phone screenshot or a link-preview banner, coloured from a seed. Server-side only (node:zlib).
 */

export type FakeImageStyle = "icon" | "screenshot" | "banner"

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** HSL (0–360, 0–1, 0–1) → RGB bytes. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

function inRoundRect(x: number, y: number, rx: number, ry: number, rw: number, rh: number, r: number) {
  if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r)
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

export function fakePng(input: { seed: string; width: number; height: number; style: FakeImageStyle }): Uint8Array {
  const width = Math.max(8, Math.min(800, Math.round(input.width)))
  const height = Math.max(8, Math.min(1400, Math.round(input.height)))
  const seed = hashSeed(input.seed)
  const hue = seed % 360
  const hue2 = (hue + 40 + (seed >> 9) % 80) % 360
  const top = hsl(hue, 0.72, 0.58)
  const bottom = hsl(hue2, 0.7, 0.42)
  const light = hsl(hue, 0.6, 0.94)
  const accent = hsl((hue + 180) % 360, 0.65, 0.55)

  const raw = new Uint8Array((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    const t = y / Math.max(1, height - 1)
    for (let x = 0; x < width; x += 1) {
      let c: [number, number, number] = [
        Math.round(top[0] + (bottom[0] - top[0]) * t),
        Math.round(top[1] + (bottom[1] - top[1]) * t),
        Math.round(top[2] + (bottom[2] - top[2]) * t),
      ]
      if (input.style === "icon") {
        const r = width * 0.26
        const dx = x - width / 2
        const dy = y - height / 2
        if (dx * dx + dy * dy < r * r) c = light
        else if (inRoundRect(x, y, width * 0.2, height * 0.68, width * 0.6, height * 0.08, height * 0.04)) {
          c = accent
        }
      } else if (input.style === "screenshot") {
        const pad = Math.round(width * 0.07)
        const cardH = Math.round(height * 0.13)
        // Header bar, then cards.
        if (inRoundRect(x, y, pad, Math.round(height * 0.06), width - 2 * pad, Math.round(height * 0.05), 6)) {
          c = light
        }
        for (let i = 0; i < 4; i += 1) {
          const cy = Math.round(height * 0.16) + i * (cardH + Math.round(height * 0.03))
          if (inRoundRect(x, y, pad, cy, width - 2 * pad, cardH, 12)) {
            c = light
            const dot = Math.round(cardH * 0.28)
            const dx = x - (pad + Math.round(cardH * 0.5))
            const dy = y - (cy + Math.round(cardH * 0.5))
            if (dx * dx + dy * dy < dot * dot) c = accent
          }
        }
        if (inRoundRect(x, y, Math.round(width * 0.3), Math.round(height * 0.86), Math.round(width * 0.4), Math.round(height * 0.06), 20)) {
          c = accent
        }
      } else {
        const r = height * 0.22
        const dx = x - width * 0.22
        const dy = y - height / 2
        if (dx * dx + dy * dy < r * r) c = light
        else if (inRoundRect(x, y, width * 0.42, height * 0.36, width * 0.45, height * 0.1, 8)) c = light
        else if (inRoundRect(x, y, width * 0.42, height * 0.54, width * 0.3, height * 0.08, 8)) c = accent
      }
      const p = row + 1 + x * 3
      raw[p] = c[0]
      raw[p + 1] = c[1]
      raw[p + 2] = c[2]
    }
  }

  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
