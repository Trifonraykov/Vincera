import { hueOf } from "./text"

/**
 * The generated cover for a listing without images (CLAUDE.md §19.45): a two-colour gradient and
 * the product's initials, deterministic from its id and title, so the same listing always looks
 * the same on the web, in the native app and in screenshots. Pure and client-safe; the web draws
 * it with CSS, the app with `experimental_backgroundImage`.
 */

export type FallbackVisual = {
  /** CSS colours (`hsl(...)`). */
  from: string
  to: string
  /** Angle of the gradient in degrees. */
  angle: number
  /** One or two letters (or a digit), upper case. */
  initials: string
  /** The CSS `linear-gradient(...)` value. */
  gradient: string
}

/** "Focus Garden: Pomodoro Timer" → "FG"; "tasktide" → "T"; "" → "•". */
export function initialsOf(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
  const letters = words
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toUpperCase()
  return letters === "" ? "•" : letters
}

export function fallbackVisual(input: { id: string; title: string }): FallbackVisual {
  const hue = hueOf(`${input.id}:${input.title}`)
  const second = (hue + 40 + (hueOf(input.title) % 60)) % 360
  const angle = 120 + (hueOf(input.id) % 100)
  const from = `hsl(${hue} 72% 56%)`
  const to = `hsl(${second} 78% 38%)`
  return {
    from,
    to,
    angle,
    initials: initialsOf(input.title),
    gradient: `linear-gradient(${angle}deg, ${from}, ${to})`,
  }
}
