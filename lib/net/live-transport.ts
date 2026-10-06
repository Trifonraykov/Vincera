import { promises as dns } from "node:dns"
import http from "node:http"
import https from "node:https"
import { isIP } from "node:net"

import { hostOf, type NetResponse, type NetTransport } from "./safe-fetch"

/**
 * The real network for `safeFetch` (CLAUDE.md §19.45). DNS goes through the system resolver
 * (every address, so safeFetch can check them all); the request connects to the **checked
 * address** with the original host in the `Host` header and as the TLS server name, so the
 * certificate is still verified for the host name and no second lookup can redirect the
 * connection. No proxy, no keep-alive, no automatic redirects or decompression.
 */
export const liveNetTransport: NetTransport = {
  resolve: async (hostname) => {
    const answers = await dns.lookup(hostname, { all: true, verbatim: true })
    return answers.map((answer) => answer.address)
  },
  request: ({ url, address, headers, signal }) =>
    new Promise<NetResponse>((resolve, reject) => {
      const secure = url.protocol === "https:"
      const host = hostOf(url)
      const request = (secure ? https : http).request(
        {
          host: address,
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { ...headers, host: url.host },
          // SNI must be a host name, never an IP literal.
          ...(secure && isIP(host) === 0 ? { servername: host } : {}),
          agent: false,
          signal,
        },
        (response) => {
          const flat: Record<string, string> = {}
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: flat,
            body: response,
            cancel: () => response.destroy(),
          })
        },
      )
      request.on("error", reject)
      request.end()
    }),
}
