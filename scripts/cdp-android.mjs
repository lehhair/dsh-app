// Drive the ANDROID WebView through the adb-forwarded devtools port.
//   node scripts/cdp-android.mjs <js-expression>
const expression = process.argv[2]
if (!expression) {
  console.error('usage: node scripts/cdp-android.mjs <js-expression>')
  process.exit(2)
}
const list = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const target = list.find((t) => t.type === 'page')
if (!target) {
  console.error('no page target')
  process.exit(1)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('ws error'))
})
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
