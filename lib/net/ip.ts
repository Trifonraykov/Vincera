import { BlockList, isIP } from "node:net"

/**
 * Which addresses an outbound fetch of a user-supplied URL may connect to (CLAUDE.md §19.45,
 * SSRF). Everything that is not ordinary public unicast is refused: private, loopback,
 * link-local (incl. cloud metadata 169.254.169.254 and fd00:ec2::254), carrier-grade NAT,
 * benchmarking, documentation, multicast, reserved and broadcast ranges, plus IPv6 forms that
 * embed an IPv4 address (mapped, NAT64, 6to4), which are checked as that IPv4 address.
 *
 * Server-only in practice (node:net), but free of `server-only` so unit tests import it directly.
 */

const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
]

const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo (tunnels to arbitrary IPv4)
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local (incl. fd00:ec2::254, AWS metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
]

const blockList = new BlockList()
for (const [address, prefix] of BLOCKED_V4) blockList.addSubnet(address, prefix, "ipv4")
for (const [address, prefix] of BLOCKED_V6) blockList.addSubnet(address, prefix, "ipv6")

/** Expand an IPv6 address to its eight 16-bit groups, or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  const zone = text.indexOf("%")
  if (zone >= 0) text = text.slice(0, zone)
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4?.[1]) {
    const octets = v4[1].split(".").map(Number)
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null
    const [a = 0, b = 0, c = 0, d = 0] = octets
    text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail]
  const groups = parts.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN))
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null
}

function v4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/**
 * The IPv4 address an IPv6 address stands for, when it embeds one: IPv4-mapped (::ffff:a.b.c.d),
 * IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96 and 64:ff9b:1::/48) and 6to4 (2002::/16).
 */
export function embeddedIpv4(address: string): string | null {
  const g = ipv6Groups(address)
  if (!g) return null
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (zeroPrefix && (g5 === 0xffff || g5 === 0) && !(g5 === 0 && g6 === 0)) {
    return v4FromGroups(g6, g7)
  }
  if (g0 === 0x64 && g1 === 0xff9b && (g2 === 0 || g2 === 1)) return v4FromGroups(g6, g7)
  if (g0 === 0x2002) return v4FromGroups(g1, g2)
  return null
}

/** True when an outbound request may connect to `address` (an IPv4 or IPv6 literal). */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "")
  const family = isIP(bare.split("%")[0] ?? "")
  if (family === 4) return !blockList.check(bare, "ipv4")
  if (family === 6) {
    const plain = bare.split("%")[0] ?? bare
    if (blockList.check(plain, "ipv6")) return false
    const v4 = embeddedIpv4(plain)
    if (v4 !== null) return isPublicAddress(v4)
    return true
  }
  return false
}

/** Host names that never resolve to something we may fetch, whatever DNS says. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "" || host === "localhost") return true
  return [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"].some((suffix) =>
    host.endsWith(suffix),
  )
}
