/**
 * What an image really is, from its bytes (CLAUDE.md §19.45): PNG, JPEG, GIF or WebP, with its
 * pixel size. The `Content-Type` a remote server sends is never trusted: anything that does not
 * sniff as one of these four (SVG, HTML, ICO, …) is not stored. Pure.
 */

export type SniffedImage = {
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  extension: "png" | "jpg" | "gif" | "webp"
  width: number | null
  height: number | null
}

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
}
function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
}
function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)
}
function u32be(b: Uint8Array, i: number): number {
  return (
    (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0
  )
}
function ascii(b: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...b.subarray(start, start + length))
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1] ?? 0
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = u16be(b, i + 2)
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    i += 2 + length
  }
  return null
}

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = bytes
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") {
    return { contentType: "image/png", extension: "png", width: u32be(b, 16), height: u32be(b, 20) }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b)
    return {
      contentType: "image/jpeg",
      extension: "jpg",
      width: size?.width ?? null,
      height: size?.height ?? null,
    }
  }
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
    return { contentType: "image/gif", extension: "gif", width: u16le(b, 6), height: u16le(b, 8) }
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4)
    let width: number | null = null
    let height: number | null = null
    if (chunk === "VP8X") {
      width = u24le(b, 24) + 1
      height = u24le(b, 27) + 1
    } else if (chunk === "VP8 ") {
      width = u16le(b, 26) & 0x3fff
      height = u16le(b, 28) & 0x3fff
    } else if (chunk === "VP8L") {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    }
    return { contentType: "image/webp", extension: "webp", width, height }
  }
  return null
}
