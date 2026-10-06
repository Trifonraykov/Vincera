import { uuidv7 } from "uuidv7"

/** New primary key: UUIDv7 (time-ordered), generated in the app (§4). */
export function newId(): string {
  return uuidv7()
}
