import "server-only"

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { now } from "@/lib/clock"
import { env } from "@/lib/env"
import { dataDir } from "@/lib/services"

import { assertExpiry, assertValidKey } from "./keys"
import { normalizeMimeType } from "./limits"
import { buildSignedUrl } from "./signing"
import {
  StorageError,
  type ObjectBody,
  type ObjectInfo,
  type ObjectStorage,
  type SignedGetOptions,
  type SignedPutOptions,
  type StoredObject,
} from "./types"

/**
 * Local-disk storage fake (§19.3). Objects live in `.data/storage/objects/<key>` with metadata in
 * `.data/storage/meta/<key>.json`. Signed URLs point at the dev route
 * `/api/dev/storage/<key>`, signed with an HMAC of AUTH_SECRET and an expiry.
 */

const metaSchema = z.object({
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
})

export function createLocalStorage(root: string = dataDir("storage")): ObjectStorage {
  const objectsRoot = path.join(root, "objects")
  const metaRoot = path.join(root, "meta")

  /** Resolve a key inside `base`, refusing anything that escapes it (defence in depth). */
  function resolveIn(base: string, key: string, suffix = ""): string {
    assertValidKey(key)
    const resolved = path.resolve(base, `${key}${suffix}`)
    if (!resolved.startsWith(`${path.resolve(base)}${path.sep}`)) {
      throw new StorageError("Storage key escapes the storage root")
    }
    return resolved
  }

  async function readMeta(key: string): Promise<ObjectInfo | null> {
    try {
      const raw: unknown = JSON.parse(await readFile(resolveIn(metaRoot, key, ".json"), "utf8"))
      const meta = metaSchema.parse(raw)
      return { contentType: meta.contentType, sizeBytes: meta.sizeBytes }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  return {
    kind: "local",

    async putObject(key: string, body: ObjectBody, contentType: string): Promise<void> {
      const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body)
      const objectPath = resolveIn(objectsRoot, key)
      const metaPath = resolveIn(metaRoot, key, ".json")
      await mkdir(path.dirname(objectPath), { recursive: true })
      await mkdir(path.dirname(metaPath), { recursive: true })
      await writeFile(objectPath, bytes)
      const meta = {
        contentType: normalizeMimeType(contentType) || "application/octet-stream",
        sizeBytes: bytes.byteLength,
        createdAt: now().toISOString(),
      }
      await writeFile(metaPath, JSON.stringify(meta), "utf8")
    },

    async getObject(key: string): Promise<StoredObject | null> {
      const info = await readMeta(key)
      if (!info) return null
      try {
        const body = await readFile(resolveIn(objectsRoot, key))
        return { ...info, body: new Uint8Array(body) }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async statObject(key: string): Promise<ObjectInfo | null> {
      const info = await readMeta(key)
      if (!info) return null
      try {
        const file = await stat(resolveIn(objectsRoot, key))
        return { ...info, sizeBytes: file.size }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async deleteObject(key: string): Promise<void> {
      await rm(resolveIn(objectsRoot, key), { force: true })
      await rm(resolveIn(metaRoot, key, ".json"), { force: true })
    },

    async signedGetUrl(key: string, options: SignedGetOptions): Promise<string> {
      assertValidKey(key)
      assertExpiry(options.expiresInSeconds)
      return buildSignedUrl(
        env.NEXT_PUBLIC_APP_URL,
        {
          op: "get",
          key,
          exp: expiryFromNow(options.expiresInSeconds),
          filename: options.filename ?? null,
        },
        env.AUTH_SECRET,
      )
    },

    async signedPutUrl(key: string, options: SignedPutOptions): Promise<string> {
      assertValidKey(key)
      assertExpiry(options.expiresInSeconds)
      assertMaxBytes(options.maxBytes)
      return buildSignedUrl(
        env.NEXT_PUBLIC_APP_URL,
        {
          op: "put",
          key,
          exp: expiryFromNow(options.expiresInSeconds),
          contentType: normalizeMimeType(options.contentType),
          maxBytes: options.maxBytes,
        },
        env.AUTH_SECRET,
      )
    },
  }
}

export function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new StorageError("maxBytes must be a positive integer")
  }
}

/** Unix seconds `seconds` from the app clock's now. */
function expiryFromNow(seconds: number): number {
  return Math.floor(now().getTime() / 1000) + seconds
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
