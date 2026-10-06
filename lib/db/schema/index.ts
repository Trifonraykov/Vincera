/**
 * The complete database schema (CLAUDE.md §5), split by domain. Import tables from here:
 * `import { users, ideas } from "@/lib/db/schema"`.
 */
export { DEFAULT_CURRENCY, EMBEDDING_DIMENSIONS, HANDLE_PATTERN, HANDLE_REGEX } from "./columns"
export * from "./enums"
export * from "./types"

export * from "./identity"
export * from "./social"
export * from "./supply"
export * from "./matching"
export * from "./collab"
export * from "./commerce"
export * from "./money"
export * from "./trust"
export * from "./events"

export * from "./relations"
