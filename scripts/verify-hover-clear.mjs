// Verify the settings-button hover clears on click, using REAL trusted
// mouse events via CDP Input domain (synthetic JS events don't affect
// :hover). Requires a Chrome with --remote-debugging-port=9333 open on
// the preview page.

const list = await fetch('http://127.0.0.1:9333/json').then((r) => r.json())
const target = list
  .filter((t) => t.type === 'page' && t.url.includes(process.argv[2] ?? 'localhost:4173'))
  .sort((a, b) => a.url.length - b.url.length)[0]
if (!target) {
  console.error('no target')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
let id = 0
const pending = new Map()
ws.onmessage = (event) => {
  const m = JSON.parse(event.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rect = await evaluate(
  `(() => { const r = document.getElementById('settings').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
)
// Move the (trusted) cursor onto the button → real :hover
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
await sleep(350)
const hoverBg = await evaluate(`getComputedStyle(document.getElementById('settings')).backgroundColor`)
// Click it
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
await sleep(500)
const afterBg = await evaluate(`getComputedStyle(document.getElementById('settings')).backgroundColor`)
// Move away and back: normal hover must still work afterwards
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 300 })
await sleep(250)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
await sleep(350)
const rehoverBg = await evaluate(`getComputedStyle(document.getElementById('settings')).backgroundColor`)

console.log(JSON.stringify({ hoverBg, afterBg, rehoverBg }))
ws.close()
process.exit(0)
