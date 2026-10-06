import "server-only"

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { env, isFake } from "@/lib/env"

import { assertExpiry, assertValidKey, contentDisposition } from "./keys"
import { normalizeMimeType } from "./limits"
import { assertMaxBytes, createLocalStorage } from "./local"
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
 * File storage entry point (§3 `lib/storage/r2.ts`): `getStorage()` returns Cloudflare R2 when
 * its credentials are configured, otherwise the local-disk fake (§19.3).
 *
 * Everything in the bucket is private. Browsers only ever see short-lived signed URLs.
 */
let localInstance: ObjectStorage | undefined
let r2Instance: ObjectStorage | undefined

export function getStorage(): ObjectStorage {
  if (isFake("storage")) return (localInstance ??= createLocalStorage())
  return (r2Instance ??= createR2Storage())
}

export type R2Config = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

function configFromEnv(): R2Config {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new StorageError("R2 credentials are not configured")
  }
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  }
}

export function createR2Storage(config: R2Config = configFromEnv()): ObjectStorage {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // R2 does not support the SDK's default CRC32 checksums on presigned requests.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
  const Bucket = config.bucket

  return {
    kind: "r2",

    async putObject(key: string, body: ObjectBody, contentType: string): Promise<void> {
      assertValidKey(key)
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: typeof body === "string" ? Buffer.from(body, "utf8") : body,
          ContentType: normalizeMimeType(contentType) || "application/octet-stream",
        }),
      )
    },

    async getObject(key: string): Promise<StoredObject | null> {
      assertValidKey(key)
      try {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: key }))
        if (!result.Body) throw new StorageError("R2 returned an object without a body")
        const body = await result.Body.transformToByteArray()
        return {
          body,
          contentType: result.ContentType ?? "application/octet-stream",
          sizeBytes: body.byteLength,
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async statObject(key: string): Promise<ObjectInfo | null> {
      assertValidKey(key)
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket, Key: key }))
        return {
          contentType: result.ContentType ?? "application/octet-stream",
          sizeBytes: result.ContentLength ?? 0,
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async deleteObject(key: string): Promise<void> {
      assertValidKey(key)
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
    },

    async copyObject(sourceKey: string, destinationKey: string): Promise<boolean> {
      assertValidKey(sourceKey)
      assertValidKey(destinationKey)
      try {
        // CopySource is "<bucket>/<key>", URL-encoded; keys only hold URL-safe characters except
        // the few that encodeURIComponent escapes per segment.
        await client.send(
          new CopyObjectCommand({
            Bucket,
            Key: destinationKey,
            CopySource: `${Bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
            MetadataDirective: "COPY",
          }),
        )
        return true
      } catch (error) {
        if (isNotFound(error)) return false
        throw error
      }
    },

    async signedGetUrl(key: string, options: SignedGetOptions): Promise<string> {
      assertValidKey(key)
      assertExpiry(options.expiresInSeconds)
      const command = new GetObjectCommand({
        Bucket,
        Key: key,
        ResponseContentDisposition: options.filename
          ? contentDisposition(options.filename)
          : undefined,
      })
      return getSignedUrl(client, command, { expiresIn: options.expiresInSeconds })
    },

    async signedPutUrl(key: string, options: SignedPutOptions): Promise<string> {
      assertValidKey(key)
      assertExpiry(options.expiresInSeconds)
      assertMaxBytes(options.maxBytes)
      const command = new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: normalizeMimeType(options.contentType),
      })
      // Signing the Content-Type header binds the upload to the type we validated.
      return getSignedUrl(client, command, {
        expiresIn: options.expiresInSeconds,
        signableHeaders: new Set(["content-type"]),
      })
    },
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404
}
