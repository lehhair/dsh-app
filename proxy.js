// Local proxy for remote dsh nodes: forwards the shell's WebContentsView to
// a remote gateway, injecting `Authorization: Bearer <key>` on every request
// including WebSocket upgrades (the only place WS handshakes can carry the
// credential — browser JS cannot set headers on new WebSocket()).
//
// Logic mirrors the verified remote-gateway proxy (hop-by-hop stripping,
// streaming bodies, 101 relay + bidirectional socket splice); differences:
// we inject the Bearer and rewrite Host to the target authority instead of
// loopback. The gateway performs the key check and rewrites to dsh itself.
//
// @module proxy

const http = require('node:http')
const https = require('node:https')

/** Hop-by-hop headers that must never cross the proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Parse a target URL into { protocol, host, port, origin }. */
function parseTarget(url) {
  const parsed = new URL(url)
  const protocol = parsed.protocol === 'https:' ? 'https' : 'http'
  const port = parsed.port !== ''
    ? Number(parsed.port)
    : (protocol === 'https' ? 443 : 80)
  return { protocol, host: parsed.hostname, port, origin: `${protocol}://${parsed.hostname}:${port}` }
}

/**
 * Build the header set for the upstream request: drop hop-by-hop headers,
 * the browser markers the gateway would otherwise see (origin, sec-fetch-*,
 * referer), and any pre-existing credentials; pin Host to the target
 * authority; inject the gateway key as a Bearer token.
 */
function forwardHeaders(headers, target, key) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'host'
      || lower === 'origin'
      || lower === 'referer'
      || lower === 'cookie'
      || lower === 'authorization'
      || lower.startsWith('sec-fetch-')
      || HOP_BY_HOP.has(lower)) {
      continue
    }
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  out.host = target.origin.replace(/^[a-z]+:\/\//, '')
  out.authorization = `Bearer ${key}`
  return out
}

/** Response headers for the client: hop-by-hop stripped, rest verbatim. */
function responseHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/** The request/response transport for one target protocol. */
function requester(target) {
  return target.protocol === 'https' ? https.request.bind(https) : http.request.bind(http)
}

/**
 * Forward one HTTP request to the remote gateway and stream the response.
 * A refused upstream answers 502 before headers, or destroys the client
 * connection after.
 */
function proxyRequest(req, res, target, key) {
  const upstreamReq = requester(target)({
    host: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: forwardHeaders(req.headers, target, key),
  })
  upstreamReq.on('response', (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders(upstreamRes.headers))
    upstreamRes.pipe(res)
  })
  upstreamReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502)
      res.end('bad gateway')
      return
    }
    res.destroy()
  })
  req.pipe(upstreamReq)
}

/**
 * Forward one WebSocket upgrade to the remote gateway and splice the two
 * sockets. A non-101 upstream response is relayed as plain HTTP and the
 * client socket is closed.
 */
function proxyUpgrade(req, clientSocket, head, target, key) {
  const headers = forwardHeaders(req.headers, target, key)
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'
  const upstreamReq = requester(target)({
    host: target.host,
    port: target.port,
    path: req.url,
    method: 'GET',
    headers,
  })
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    let headText = 'HTTP/1.1 101 Switching Protocols\r\n'
    const upgrade = upstreamRes.headers.upgrade
    const connection = upstreamRes.headers.connection
    headText += `Upgrade: ${Array.isArray(upgrade) ? upgrade.join(', ') : String(upgrade ?? 'websocket')}\r\n`
    headText += `Connection: ${Array.isArray(connection) ? connection.join(', ') : String(connection ?? 'Upgrade')}\r\n`
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      headText += `${name}: ${Array.isArray(value) ? value.join(', ') : String(value)}\r\n`
    }
    headText += '\r\n'
    clientSocket.write(headText)
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    const destroyPair = () => {
      clientSocket.destroy()
      upstreamSocket.destroy()
    }
    clientSocket.on('close', () => { upstreamSocket.destroy() })
    clientSocket.on('error', destroyPair)
    upstreamSocket.on('close', () => { clientSocket.destroy() })
    upstreamSocket.on('error', destroyPair)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  })
  upstreamReq.on('response', (upstreamRes) => {
    let text = `HTTP/1.1 ${String(upstreamRes.statusCode ?? 502)} ${upstreamRes.statusMessage ?? ''}\r\n`
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      text += `${name}: ${Array.isArray(value) ? value.join(', ') : String(value)}\r\n`
    }
    text += '\r\n'
    clientSocket.write(text)
    clientSocket.destroy()
  })
  upstreamReq.on('error', () => {
    clientSocket.destroy()
  })
  upstreamReq.end()
}

/**
 * Start a loopback proxy for one remote node.
 * @param url - gateway base URL (http://host:port).
 * @param key - the gateway access key.
 * @returns {Promise<{ server: import('node:http').Server, port: number }>}
 */
function startRemoteProxy(url, key) {
  const target = parseTarget(url)
  const server = http.createServer((req, res) => proxyRequest(req, res, target, key))
  server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, target, key))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve({ server, port: server.address().port })
    })
  })
}

/** Stop a proxy server, closing its connections. */
function stopRemoteProxy(proxy) {
  if (!proxy) return
  proxy.server.closeAllConnections?.()
  proxy.server.close(() => {})
}

module.exports = { startRemoteProxy, stopRemoteProxy, parseTarget }
