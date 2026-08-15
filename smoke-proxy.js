// Stage-1 smoke: loopback proxy injecting Bearer against the live 8443
// gateway. Verifies HTTP (200 + boot manifest) and the WebSocket downlink
// handshake — the two carriers the shell view needs.
const { startRemoteProxy, stopRemoteProxy } = require('./proxy')
const http = require('node:http')

const GATEWAY = process.env.SMOKE_GATEWAY ?? 'http://127.0.0.1:8443'
const KEY = process.env.SMOKE_KEY ?? 'test-key-0123456789abcdef'

async function main() {
  const { server, port } = await startRemoteProxy(GATEWAY, KEY)
  console.log(`proxy on 127.0.0.1:${port} -> ${GATEWAY}`)

  http.get(`http://127.0.0.1:${port}/`, (res) => {
    let data = ''
    res.on('data', (chunk) => { data += chunk })
    res.on('end', () => {
      console.log(`HTTP ${res.statusCode}, boot injected: ${data.includes('__DSH_BOOT__')}`)
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`)
      const timer = setTimeout(() => { console.error('WS TIMEOUT'); process.exit(1) }, 8000)
      ws.onopen = () => {
        clearTimeout(timer)
        console.log('WS handshake OK (downlink authenticated through proxy)')
        ws.close()
        stopRemoteProxy({ server })
        process.exit(0)
      }
      ws.onerror = (event) => {
        clearTimeout(timer)
        console.error('WS ERROR', event.message ?? String(event))
        process.exit(1)
      }
    })
  }).on('error', (error) => {
    console.error('HTTP ERROR', error.message)
    process.exit(1)
  })
}

main().catch((error) => { console.error(error); process.exit(1) })
