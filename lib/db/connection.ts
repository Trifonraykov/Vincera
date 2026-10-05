import type { PoolConfig } from "pg"

/**
 * How the app, the scripts and the migrations connect to Postgres (pure; reads no environment).
 *
 * Hosted Postgres such as Supabase needs two things beyond a URL:
 * - **TLS against a private CA.** Supabase signs its database certificates with its own root CA,
 *   which Node does not trust, so `sslmode=require` (which node-postgres treats as verify-full)
 *   fails with "self-signed certificate in certificate chain". `DATABASE_CA_CERT` holds that CA
 *   (PEM, from the project's Database settings); with it the connection is encrypted and the
 *   server is verified. The URL's own `ssl*` parameters are then dropped, because node-postgres
 *   lets URL parameters override the `ssl` option.
 * - **Pooling.** Supabase's transaction pooler (Supavisor, port 6543) does not keep session state
 *   between transactions. The app never relies on any: drizzle sends unnamed statements, settings
 *   such as `app.gdpr_erasure` are transaction-local, and advisory locks are only used by the test
 *   tooling.
 */

/** URL parameters node-postgres reads for TLS. */
const SSL_PARAMS = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]

export type DatabaseConnectionOptions = {
  /** PEM certificate(s) of the CA that signs the server's certificate (DATABASE_CA_CERT). */
  caCert?: string | undefined
}

/**
 * A PEM as stored in an environment variable: real newlines, or `\n` escapes (one-line values in
 * dashboards and `.env` files). Returns null for anything that holds no certificate.
 */
export function normalizePem(value: string): string | null {
  const pem = value.replaceAll("\\n", "\n").replaceAll("\r\n", "\n").trim()
  return /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(pem)
    ? `${pem}\n`
    : null
}

/** The `pg` pool settings for `connectionString`. */
export function databasePoolConfig(
  connectionString: string,
  options: DatabaseConnectionOptions = {},
): PoolConfig {
  const ca = options.caCert ? normalizePem(options.caCert) : null
  if (options.caCert && !ca) {
    throw new Error("DATABASE_CA_CERT does not contain a PEM certificate")
  }
  if (!ca) return { connectionString }

  const url = new URL(connectionString)
  for (const param of SSL_PARAMS) url.searchParams.delete(param)
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } }
}

/** Hosts of Supabase databases: `db.<ref>.supabase.co` and `<region>.pooler.supabase.com`. */
export function isSupabaseHost(hostname: string): boolean {
  return /(^|\.)supabase\.(co|com)$/i.test(hostname)
}

/**
 * How node-postgres secures a connection to `connectionString` with `options` (mirrors
 * pg-connection-string's URL parsing; tests/unit/db/connection.test.ts compares the two):
 * - `own_ca`: TLS, the server checked against a CA we supply (`DATABASE_CA_CERT`, or the file in
 *   the URL's `sslrootcert`).
 * - `public_ca`: TLS, the server checked against Node's built-in public CAs. node-postgres treats
 *   `sslmode=require`, `prefer` and `verify-ca` like `verify-full`, so against a server signed by
 *   a private CA (Supabase) the connection fails: "self-signed certificate in certificate chain".
 * - `unverified`: TLS without checking the server (`sslmode=no-verify`, or libpq-compatible
 *   `prefer` / `require` without a root certificate): encrypted, but open to an impostor.
 * - `none`: plain text.
 */
export type DatabaseTls = "own_ca" | "public_ca" | "unverified" | "none"

export function databaseTls(
  connectionString: string,
  options: DatabaseConnectionOptions = {},
): DatabaseTls {
  // databasePoolConfig drops the URL's TLS parameters and verifies against this CA.
  if (options.caCert && normalizePem(options.caCert)) return "own_ca"
  let params: URLSearchParams
  try {
    params = new URL(connectionString).searchParams
  } catch {
    return "none"
  }
  const mode = params.get("sslmode")
  const rootCert = params.get("sslrootcert")
  const tls =
    params.get("ssl") === "true" ||
    params.get("ssl") === "1" ||
    Boolean(mode || rootCert || params.get("sslcert") || params.get("sslkey")) ||
    (params.get("sslnegotiation") === "direct" && !params.has("ssl"))
  if (!tls || mode === "disable") return "none"

  const verified: DatabaseTls = rootCert ? "own_ca" : "public_ca"
  if (params.get("uselibpqcompat") === "true") {
    if (mode === "prefer") return "unverified"
    if (mode === "require") return rootCert ? "own_ca" : "unverified"
    return verified
  }
  return mode === "no-verify" ? "unverified" : verified
}

/**
 * Whether connecting to `connectionString` with `options` uses TLS at all (verified or not).
 */
export function usesTls(
  connectionString: string,
  options: DatabaseConnectionOptions = {},
): boolean {
  return databaseTls(connectionString, options) !== "none"
}

/**
 * Production's rule for a Supabase `DATABASE_URL` (lib/env.ts): the connection must be encrypted
 * and verified against Supabase's own CA, since a setting that validates but fails on the first
 * query, or that skips verification, should never pass. Null when the URL is fine (or not a
 * Supabase host); otherwise the problem in plain words.
 */
export function supabaseTlsProblem(
  connectionString: string,
  options: DatabaseConnectionOptions = {},
): string | null {
  let hostname: string
  try {
    hostname = new URL(connectionString).hostname
  } catch {
    return null
  }
  if (!isSupabaseHost(hostname)) return null
  const fix =
    "set DATABASE_CA_CERT to the CA certificate from the Supabase dashboard (Database settings → SSL configuration → Download certificate)"
  switch (databaseTls(connectionString, options)) {
    case "own_ca":
      return null
    case "none":
      return `Supabase connections must use TLS: ${fix}`
    case "public_ca":
      return `Supabase signs its certificates with its own CA, which Node does not trust, so this connection would fail: ${fix}`
    case "unverified":
      return `this sslmode does not verify the Supabase server: ${fix}`
  }
}
