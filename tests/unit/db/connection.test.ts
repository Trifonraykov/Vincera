import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import {
  databasePoolConfig,
  databaseTls,
  isSupabaseHost,
  normalizePem,
  supabaseTlsProblem,
  usesTls,
} from "@/lib/db/connection"

/** node-postgres's own URL parser (a dependency of `pg`, not of the app). */
type ParsedSsl = boolean | { ca?: string; rejectUnauthorized?: boolean } | undefined
const parsePgUrl = createRequire(createRequire(import.meta.url).resolve("pg"))(
  "pg-connection-string",
).parse as (url: string) => { ssl?: ParsedSsl }

/** Shape only; not a real CA. */
const PEM =
  "-----BEGIN CERTIFICATE-----\nMIIDxTCCAq2gAwIBAgIBADANBgkqhkiG9w0BAQsFADA=\n-----END CERTIFICATE-----"
const POOLER =
  "postgresql://postgres.abcdefghijklmnop:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"

describe("databasePoolConfig", () => {
  it("passes the URL through when no CA is configured", () => {
    expect(databasePoolConfig("postgres://u:p@localhost:5432/db?sslmode=disable")).toEqual({
      connectionString: "postgres://u:p@localhost:5432/db?sslmode=disable",
    })
  })

  it("verifies the server against DATABASE_CA_CERT and drops the URL's TLS parameters", () => {
    const config = databasePoolConfig(`${POOLER}?sslmode=require&application_name=app`, {
      caCert: PEM,
    })
    // node-postgres lets URL parameters override `ssl`, so they must be gone.
    expect(config.connectionString).toBe(`${POOLER}?application_name=app`)
    expect(config.ssl).toEqual({ ca: `${PEM}\n`, rejectUnauthorized: true })
  })

  it("accepts a one-line PEM with \\n escapes, as dashboards store it", () => {
    const config = databasePoolConfig(POOLER, { caCert: PEM.replaceAll("\n", "\\n") })
    expect(config.ssl).toEqual({ ca: `${PEM}\n`, rejectUnauthorized: true })
  })

  it("refuses a CA value that holds no certificate", () => {
    expect(() => databasePoolConfig(POOLER, { caCert: "not a certificate" })).toThrow(
      "DATABASE_CA_CERT",
    )
    expect(normalizePem("")).toBeNull()
  })
})

describe("isSupabaseHost / usesTls", () => {
  it("recognises Supabase's direct and pooler hosts", () => {
    expect(isSupabaseHost("db.abcdefghijklmnop.supabase.co")).toBe(true)
    expect(isSupabaseHost("aws-0-eu-central-1.pooler.supabase.com")).toBe(true)
    expect(isSupabaseHost("localhost")).toBe(false)
    expect(isSupabaseHost("supabase.com.evil.example")).toBe(false)
  })

  it("follows node-postgres: any sslmode but disable means TLS", () => {
    expect(usesTls(POOLER)).toBe(false)
    expect(usesTls(`${POOLER}?sslmode=disable`)).toBe(false)
    for (const mode of ["prefer", "require", "verify-full", "no-verify"]) {
      expect(usesTls(`${POOLER}?sslmode=${mode}`)).toBe(true)
    }
    expect(usesTls(`${POOLER}?ssl=true`)).toBe(true)
    expect(usesTls(POOLER, { caCert: PEM })).toBe(true)
  })
})

describe("databaseTls", () => {
  it("classifies URLs exactly as node-postgres's parser configures them", () => {
    // The parser warns (once per process) that require/prefer/verify-ca mean verify-full today.
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined)
    onTestFinished(() => warn.mockRestore())
    const rootCert = path.join(mkdtempSync(path.join(tmpdir(), "db-tls-")), "root.crt")
    writeFileSync(rootCert, PEM)
    const queries = [
      "",
      "ssl=true",
      "ssl=1",
      "ssl=0",
      "sslmode=disable",
      "sslnegotiation=direct",
      `sslrootcert=${rootCert}`,
      ...["prefer", "require", "verify-ca", "verify-full", "no-verify"].flatMap((mode) => [
        `sslmode=${mode}`,
        `sslmode=${mode}&sslrootcert=${rootCert}`,
        `sslmode=${mode}&uselibpqcompat=true`,
        `sslmode=${mode}&uselibpqcompat=true&sslrootcert=${rootCert}`,
      ]),
    ]
    for (const query of queries) {
      const url = query ? `${POOLER}?${query}` : POOLER
      let ssl: ParsedSsl
      try {
        ssl = parsePgUrl(url).ssl
      } catch {
        // libpq-compatible verify-ca without a root certificate is refused by the parser.
        expect([query, databaseTls(url)]).toEqual([query, "public_ca"])
        continue
      }
      const expected = !ssl
        ? "none"
        : typeof ssl === "object" && ssl.rejectUnauthorized === false
          ? "unverified"
          : typeof ssl === "object" && ssl.ca
            ? "own_ca"
            : "public_ca"
      expect([query, databaseTls(url)]).toEqual([query, expected])
    }
  })

  it("counts DATABASE_CA_CERT as our own CA whatever the URL says", () => {
    expect(databaseTls(`${POOLER}?sslmode=disable`, { caCert: PEM })).toBe("own_ca")
    expect(databaseTls(POOLER, { caCert: "not a certificate" })).toBe("none")
  })
})

describe("supabaseTlsProblem", () => {
  it("accepts only a connection verified against our own CA, and ignores other hosts", () => {
    expect(supabaseTlsProblem(POOLER, { caCert: PEM })).toBeNull()
    expect(supabaseTlsProblem(`${POOLER}?sslmode=require`)).toMatch(
      /would fail: set DATABASE_CA_CERT/,
    )
    expect(supabaseTlsProblem(`${POOLER}?sslmode=no-verify`)).toMatch(/does not verify/)
    expect(supabaseTlsProblem(POOLER)).toMatch(/must use TLS/)
    expect(supabaseTlsProblem("postgres://postgres:postgres@127.0.0.1:54322/postgres")).toBeNull()
    expect(supabaseTlsProblem("not a url")).toBeNull()
  })
})
