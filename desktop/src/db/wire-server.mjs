/**
 * A PostgreSQL wire-protocol server in front of one PGlite instance, so node-postgres (the app's
 * driver) can connect to the embedded database over TCP.
 *
 * PGlite is a single Postgres backend: every client shares one session. To make several pool
 * connections safe, a client owns the backend from its first message until the backend reports
 * ReadyForQuery with status "idle" (no transaction open, no extended-protocol batch pending).
 * Other clients wait in arrival order. That is transaction pooling, the mode the platform already
 * supports for Supabase's transaction pooler (CLAUDE.md §19.21: unnamed statements only,
 * transaction-local settings only).
 *
 * Why not @electric-sql/pglite-socket's multiplexer: it switches clients between individual
 * messages whenever no explicit transaction is open, so one client's Parse/Bind/Execute/Sync batch
 * can interleave with another's and both get the wrong results. Its framing is mirrored here.
 */
import { createServer } from "node:net"

const SSL_REQUEST = 80877103
const GSSENC_REQUEST = 80877104
const CANCEL_REQUEST = 80877102
const PROTOCOL_3 = 196608

/** Message types after which the backend answers with ReadyForQuery. */
const SYNCING = new Set(["Q", "S"])

export function createWireServer(db, { log = () => undefined } = {}) {
  /** The connection that owns the backend, or null. */
  let owner = null
  /** Connections waiting for the backend, in arrival order. */
  const waiting = []
  const connections = new Set()
  let nextId = 1

  function acquire(conn) {
    if (owner === conn) return Promise.resolve()
    if (owner === null) {
      owner = conn
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      // A client that waits this long usually means one connection holds a transaction while the
      // same code waits on another connection: worth a line in the log.
      const timer = setTimeout(
        () => log(`[db] connection ${conn.id} has waited 15s for connection ${owner?.id}`),
        15_000,
      )
      waiting.push({
        conn,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
      })
    })
  }

  function release(conn) {
    if (owner !== conn) return
    owner = null
    while (waiting.length > 0) {
      const next = waiting.shift()
      if (next.conn.closed) continue
      owner = next.conn
      next.resolve()
      return
    }
  }

  /** Run one protocol message on the backend; returns the ReadyForQuery status seen last, if any. */
  async function run(message, onData) {
    let tail = Buffer.alloc(0)
    await db.runExclusive(() =>
      db.execProtocolRawStream(message, {
        onRawData: (chunk) => {
          const buffer = Buffer.from(chunk)
          tail = Buffer.concat([tail, buffer]).subarray(-6)
          onData(buffer)
        },
      }),
    )
    // ReadyForQuery: 'Z', int32 length 5, status byte ('I' idle, 'T' in transaction, 'E' failed).
    if (tail.length === 6 && tail[0] === 0x5a && tail.readInt32BE(1) === 5) {
      return String.fromCharCode(tail[5])
    }
    return null
  }

  /** Bring the shared session back to idle after a client vanished mid-batch or mid-transaction. */
  async function resetSession() {
    try {
      // Ends a pending extended-protocol batch (the answer is discarded).
      await run(new Uint8Array([0x53, 0, 0, 0, 4]), () => undefined)
      if (db.isInTransaction()) await db.exec("ROLLBACK")
    } catch (error) {
      log(`[db] could not reset the session: ${error?.message ?? error}`)
    }
  }

  function handle(socket) {
    const conn = { id: nextId++, socket, closed: false, started: false }
    connections.add(conn)
    socket.setNoDelay(true)
    let buffer = Buffer.alloc(0)
    let chain = Promise.resolve()

    const write = (data) => {
      if (!conn.closed && socket.writable) socket.write(data)
    }

    const close = () => {
      if (conn.closed) return
      conn.closed = true
      connections.delete(conn)
      chain = chain.then(async () => {
        if (owner === conn) {
          await resetSession()
          release(conn)
        }
      })
    }

    async function runMessage(message, type) {
      if (conn.closed) return
      await acquire(conn)
      if (conn.closed) {
        release(conn)
        return
      }
      try {
        const status = await run(message, write)
        if (status === "I" && (type === null || SYNCING.has(type))) release(conn)
      } catch (error) {
        log(`[db] connection ${conn.id}: ${error?.message ?? error}`)
        socket.destroy()
        close()
      }
    }

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data])
      for (;;) {
        if (!conn.started) {
          if (buffer.length < 8) return
          const length = buffer.readInt32BE(0)
          const code = buffer.readInt32BE(4)
          if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
            buffer = buffer.subarray(8)
            write(Buffer.from("N")) // No TLS on a loopback socket.
            continue
          }
          if (code === CANCEL_REQUEST) {
            socket.end() // Not supported, like pglite-socket.
            return
          }
          if (buffer.length < length) return
          if (code !== PROTOCOL_3) {
            socket.destroy()
            return
          }
          const startup = new Uint8Array(buffer.subarray(0, length))
          buffer = buffer.subarray(length)
          conn.started = true
          chain = chain.then(() => runMessage(startup, null))
          continue
        }
        if (buffer.length < 5) return
        const length = 1 + buffer.readInt32BE(1)
        if (buffer.length < length) return
        const type = String.fromCharCode(buffer[0])
        const message = new Uint8Array(buffer.subarray(0, length))
        buffer = buffer.subarray(length)
        if (type === "X") {
          // Terminate: the session is shared, so it is never forwarded to the backend.
          socket.end()
          close()
          return
        }
        chain = chain.then(() => runMessage(message, type))
      }
    })
    socket.on("error", () => close())
    socket.on("close", () => close())
  }

  const server = createServer(handle)

  return {
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
          server.off("error", reject)
          resolve(server.address().port)
        })
      })
    },
    async close() {
      for (const conn of connections) conn.socket.destroy()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
