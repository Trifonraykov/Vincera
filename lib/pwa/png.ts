/**
 * Tiny PNG and ICO helpers for the app icons (scripts/pwa-icons.ts writes them, the unit tests
 * read them back). Pure functions over byte arrays; no image library.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Signature (8), IHDR length (4), "IHDR" (4), then width and height, big-endian.
  const type = String.fromCharCode(...bytes.subarray(12, 16))
  if (type !== "IHDR") return null
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * An ICO file holding PNG images (supported by every browser that reads favicon.ico), one
 * directory entry per size. Sizes are at most 256 px (stored as 0 in the one-byte fields).
 */
export function encodeIco(images: readonly { size: number; png: Uint8Array }[]): Uint8Array {
  const headerSize = 6
  const entrySize = 16
  let offset = headerSize + entrySize * images.length
  const total = offset + images.reduce((sum, image) => sum + image.png.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true) // reserved
  view.setUint16(2, 1, true) // type: icon
  view.setUint16(4, images.length, true)
  images.forEach((image, index) => {
    if (image.size < 1 || image.size > 256) throw new Error(`ICO size out of range: ${image.size}`)
    const entry = headerSize + entrySize * index
    out[entry] = image.size === 256 ? 0 : image.size
    out[entry + 1] = image.size === 256 ? 0 : image.size
    out[entry + 2] = 0 // palette colours
    out[entry + 3] = 0 // reserved
    view.setUint16(entry + 4, 1, true) // colour planes
    view.setUint16(entry + 6, 32, true) // bits per pixel
    view.setUint32(entry + 8, image.png.length, true)
    view.setUint32(entry + 12, offset, true)
    out.set(image.png, offset)
    offset += image.png.length
  })
  return out
}

/** The images inside an ICO file: their declared size and their PNG bytes (tests). */
export function decodeIco(bytes: Uint8Array): { size: number; png: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    throw new Error("Not an ICO file")
  }
  const count = view.getUint16(4, true)
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + 16 * index
    const size = bytes[entry] === 0 ? 256 : (bytes[entry] ?? 0)
    const length = view.getUint32(entry + 8, true)
    const start = view.getUint32(entry + 12, true)
    return { size, png: bytes.subarray(start, start + length) }
  })
}
