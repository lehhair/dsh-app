// Verify the back-button injection fix: re-evaluating the inject script in
// the same document (Android WebView fires onPageStarted/onPageFinished
// repeatedly — redirect chains, WebView quirks — and wry re-injects init
// scripts on every page load) must not produce a second "回到启动页" button.
//
// Covers BOTH injection paths:
//   - dsh-mobile (Capacitor): inline <script id="inject-back-js"> in www/index.html
//   - src-tauri (Tauri, incl. the released Android app): NODE_VIEW_SCRIPT in inject.rs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function extractInline(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8')
  const m = html.match(/<script id="inject-back-js">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('no inline inject script in ' + htmlPath)
  return m[1].trim()
}

function extractRust(raw) {
  const m = raw.match(/r#"\n([\s\S]*?)\n"#;/)
  if (!m) throw new Error('no raw script in inject.rs')
  return m[1].trim()
}

const scripts = {
  'mobile (Capacitor)': extractInline('dsh-mobile/www/index.html'),
  'tauri inject.rs': extractRust(readFileSync('src-tauri/src/app/inject.rs', 'utf8')),
}

// ---- copies in sync? ----
const mobileCopies = [
  extractInline('dsh-mobile/www/index.html'),
  extractInline('dsh-mobile/android/app/src/main/assets/public/index.html'),
  readFileSync('dsh-mobile/www/inject-back.js', 'utf8').trim(),
  readFileSync('dsh-mobile/android/app/src/main/assets/public/inject-back.js', 'utf8').trim(),
]
const synced = mobileCopies.every((b) => b === mobileCopies[0])
console.log('mobile copies in sync:', synced ? 'YES' : 'NO')

// ---- functional simulation ----
function makeDom() {
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
  const host = makeEl('host')
  const seat = { parentElement: host }
  const head = makeEl('head')
  const dialog = makeEl('dialog')
  const document = {
    readyState: 'complete',
    documentElement: makeEl('html'),
    body: makeEl('body'),
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
    getComputedStyle() {
      return { getPropertyValue: () => '' }
    },
    MutationObserver: class {
      observe() {}
    },
    setInterval(fn) {
      // Fire the first tick synchronously: inject.rs only schedules its
      // watcher via setInterval, unlike the Capacitor script's eager call.
      fn()
      return 1
    },
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(script, ctx)
  return ctx
}

let failed = false
for (const [name, script] of Object.entries(scripts)) {
  const { document, host } = makeDom()
  const ctx = evaluate(script, document) // 1st evaluation (initial page load)
  evaluate(script, document) // 2nd evaluation — page-load re-fire
  const afterGuard = host.children.filter((c) => c.className === 'dsh-app-back-to-launcher').length
  const ok1 = afterGuard === 1
  console.log(`[${name}] buttons after 2 evaluations:`, afterGuard, ok1 ? '(OK)' : '(FAIL)')

  // Belt-and-braces: if a second copy somehow ran anyway, it must adopt the
  // existing button instead of appending a duplicate.
  ctx.window.__dshAppBackInjected = false
  evaluate(script, document)
  const afterBelt = host.children.filter((c) => c.className === 'dsh-app-back-to-launcher').length
  const ok2 = afterBelt === 1
  console.log(`[${name}] buttons after forced 3rd copy:`, afterBelt, ok2 ? '(OK)' : '(FAIL)')

  // Dialog closed (watcher lost the reference) then reopened with the old
  // button still in the DOM — the guard must adopt, not append.
  host.children = []
  ctx.window.__dshAppBackInjected = false
  evaluate(script, document)
  const b1 = host.children.find((c) => c.className === 'dsh-app-back-to-launcher')
  ctx.window.__dshAppBackInjected = false
  evaluate(script, document) // second copy with the button still present
  const reopened = host.children.filter((c) => c.className === 'dsh-app-back-to-launcher').length
  const ok3 = reopened === 1 && b1 === host.children.find((c) => c.className === 'dsh-app-back-to-launcher')
  console.log(`[${name}] buttons on reopen with stale DOM:`, reopened, ok3 ? '(OK)' : '(FAIL)')

  if (!ok1 || !ok2 || !ok3) failed = true
}

process.exit(synced && !failed ? 0 : 1)
