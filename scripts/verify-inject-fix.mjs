// Verify the mobile inject-back fix: re-evaluating the script in the same
// document (Android onPageFinished can fire repeatedly) must not produce a
// second "回到启动页" button.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function extractInline(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8')
  const m = html.match(/<script id="inject-back-js">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('no inline inject script in ' + htmlPath)
  return m[1].trim()
}

// ---- copies in sync? ----
const wwwHtml = extractInline('dsh-mobile/www/index.html')
const pubHtml = extractInline('dsh-mobile/android/app/src/main/assets/public/index.html')
const wwwFile = readFileSync('dsh-mobile/www/inject-back.js', 'utf8').trim()
const pubFile = readFileSync('dsh-mobile/android/app/src/main/assets/public/inject-back.js', 'utf8').trim()
const bodies = [wwwHtml, pubHtml, wwwFile, pubFile]
const synced = bodies.every((b) => b === bodies[0])
console.log('copies in sync:', synced ? 'YES' : 'NO')

// ---- functional simulation ----
function makeDom() {
  const host = makeEl('host')
  const seat = { parentElement: host }
  const head = makeEl('head')
  function makeEl(tag) {
    return {
      tagName: tag,
      children: [],
      id: null,
      className: '',
      textContent: '',
      type: '',
      isConnected: false,
      listeners: {},
      appendChild(child) {
        child.isConnected = true
        this.children.push(child)
        return child
      },
      addEventListener(ev, fn) {
        this.listeners[ev] = fn
      },
      querySelector(sel) {
        return this.children.find((c) => c.className === sel.slice(1)) ?? null
      },
    }
  }
  const dialog = makeEl('dialog')
  const document = {
    head,
    getElementById(id) {
      return head.children.find((c) => c.id === id) ?? null
    },
    createElement(tag) {
      return makeEl(tag)
    },
    querySelector(sel) {
      if (sel === '[data-slot="settings.action"]') return seat
      if (sel === '[role="dialog"][aria-modal="true"]') return dialog
      return null
    },
  }
  return { document, host, head }
}

function evaluate(script, document) {
  const ctx = {
    window: {},
    document,
    navigator: { userAgent: '' },
    setInterval() {
      return 1
    },
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(script, ctx)
  return ctx
}

const script = bodies[0]
const { document, host } = makeDom()
const ctx = evaluate(script, document) // 1st evaluation (initial page load)
evaluate(script, document) // 2nd evaluation — onPageFinished re-fire
const afterGuard = host.children.filter((c) => c.className === 'dsh-app-back-to-launcher').length
console.log('buttons after 2 evaluations:', afterGuard, afterGuard === 1 ? '(OK)' : '(FAIL)')

// Belt-and-braces: if a second copy somehow ran anyway, it must adopt the
// existing button instead of appending a duplicate.
ctx.window.__dshAppBackInjected = false
evaluate(script, document)
const afterBelt = host.children.filter((c) => c.className === 'dsh-app-back-to-launcher').length
console.log('buttons after forced 3rd copy:', afterBelt, afterBelt === 1 ? '(OK)' : '(FAIL)')

// Watch behavior: dialog closed then reopened still yields exactly one button.
host.children = []
ctx.window.__dshAppBackInjected = false
evaluate(script, document)
evaluate(script, document)
const reopened = host.children.filter((c) => c.className === 'dsh-app-back-to-launcher').length
console.log('buttons on reopen:', reopened, reopened === 1 ? '(OK)' : '(FAIL)')

process.exit(synced && afterGuard === 1 && afterBelt === 1 && reopened === 1 ? 0 : 1)
