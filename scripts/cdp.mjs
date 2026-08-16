// Minimal CDP helper for driving the running app from scripts:
//   node scripts/cdp.mjs <url-filter> <js-expression>
// Connects to the first /json target whose url includes <url-filter>, evals
// the expression (returnByValue, awaitPromise), prints the result value (or
// TIMEOUT / THROW), exits 0/1. Hard 15s timeout on the eval response.
const filter = process.argv[2]
const expression = process.argv[3]
if (!filter || !expression) {
  console.error('usage: node scripts/cdp.mjs <url-filter> <js-expression>')
  process.exit(2)
}

const list = await fetch('http://127.0.0.1:9333/json').then((r) => r.json())
// Prefer the shortest matching url (the launcher 'http://tauri.localhost/'
// vs. child pages like 'http://tauri.localhost/settings.html').
const target = list
  .filter((t) => t.type === 'page' && t.url.includes(filter))
  .sort((a, b) => a.url.length - b.url.length)[0]
if (!target) {
  console.error(`no target for filter: ${filter}`)
  console.error(list.map((t) => `${t.type} | ${t.url}`).join('\n'))
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
const opened = new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('ws error'))
})
await opened

const result = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timeout: true }), 15000)
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === 1) {
      clearTimeout(timer)
      resolve(msg)
    }
  }
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  }))
})
ws.close()

if (result.timeout) {
  console.log('TIMEOUT')
  process.exit(0)
}
if (result.result && result.result.exceptionDetails) {
  console.log('THROW: ' + (result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text))
  process.exit(0)
}
const value = result.result?.result?.value
if (value !== undefined) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value))
} else {
  console.log('?')
}
