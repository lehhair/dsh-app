// Mobile bridge: the launcher's single interface to the native layer.
// Node storage rides @capacitor/preferences (simple KV, survives restarts);
// connecting opens the remote dsh page in an in-app WebView
// (@capacitor/inappbrowser openInWebView) — not the system browser — so the
// app never leaves; the WebView's own close button routes back to the
// launcher. In the desktop verification build this file is swapped for a
// mock that talks to the Electron shell instead.

(async () => {
  const Cap = window.Capacitor
  const Prefs = Cap?.Plugins?.Preferences
  const InAppBrowser = Cap?.Plugins?.InAppBrowser
  const StatusBar = Cap?.Plugins?.StatusBar

  const NODES_KEY = 'dsh-mobile-nodes'
  const LAST_KEY = 'dsh-mobile-last'

  async function readNodes() {
    if (!Prefs) return []
    const { value } = await Prefs.get({ key: NODES_KEY })
    try { return JSON.parse(value ?? '[]') } catch { return [] }
  }

  async function writeNodes(nodes) {
    if (!Prefs) return
    await Prefs.set({ key: NODES_KEY, value: JSON.stringify(nodes) })
  }

  // Capacitor injects the plugin bridge asynchronously; the IIFE may beat it.
  // Re-read plugin refs at call time (the IIFE snapshot may be stale).
  function whenCapacitorReady(fn) {
    const run = () => {
      const sb = window.Capacitor?.Plugins?.StatusBar
      if (sb) fn(sb)
    }
    if (window.Capacitor?.isNativePlatform?.()) {
      if (window.Capacitor.Plugins?.StatusBar) {
        run()
      } else {
        window.Capacitor.addListener?.('capacitorReady', run)
      }
    } else if (document.readyState === 'complete') {
      run()
    } else {
      window.addEventListener('DOMContentLoaded', run, { once: true })
    }
  }

  window.Bridge = {
    listNodes: () => readNodes(),

    saveNode: async (input) => {
      const nodes = await readNodes()
      const url = String(input.url || '').trim()
      if (!/^https?:\/\//i.test(url)) {
        return { error: '地址需要以 http:// 或 https:// 开头' }
      }
      const existing = nodes.find((n) => n.id === input.id)
      const record = {
        id: existing?.id ?? `n${Date.now().toString(36)}`,
        name: input.name.trim() || url,
        url,
      }
      // Key never persisted in plaintext in the real build (would ride the
      // system keystore); kept here for the desktop mock parity. Empty key on
      // edit keeps the previously saved one (desktop behavior).
      if (input.key) record.key = input.key
      else if (existing?.key) record.key = existing.key
      if (existing) {
        const i = nodes.indexOf(existing)
        nodes[i] = { ...existing, ...record }
      } else {
        nodes.push(record)
      }
      await writeNodes(nodes)
      return { ok: true, node: record }
    },

    removeNode: async (id) => {
      const nodes = await readNodes()
      await writeNodes(nodes.filter((n) => n.id !== id))
    },

    connect: async (id) => {
      const nodes = await readNodes()
      const node = nodes.find((n) => n.id === id)
      if (!node) return { error: '节点不存在' }
      const DshNative = window.Capacitor?.Plugins?.DshNative
      if (!DshNative) return { error: '当前环境不支持原生 WebView' }
      await Prefs?.set({ key: LAST_KEY, value: node.url })

      // 1. Gateway session: same login as the desktop shell (POST
      //    /_gateway/login), performed natively so there is no CORS wall.
      let cookie = null
      if (node.key) {
        const login = await DshNative.login({ url: node.url, key: node.key })
        if (login?.ok && login.cookie) cookie = login.cookie
      }

      // 2. Inject the "回到启动页" button script (desktop-proven). The page
      //    calls DshNativeBridge.close() to pop back to the launcher.
      const injectScript = document.getElementById('inject-back-js')?.textContent

      // 3. Open the gateway with the cookie pre-injected — no login flash.
      await DshNative.open({
        url: node.url,
        cookieName: 'dsh_gateway_key',
        cookieValue: cookie ?? '',
        injectScript: injectScript ?? '',
      })
      return { ok: true, authed: Boolean(cookie) }
    },
  }

  whenCapacitorReady(async (sb) => {
    if (!sb) return
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    await sb.setOverlaysWebView({ overlay: true })
    await sb.setStyle({ style: dark ? 'DARK' : 'LIGHT' })
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async (e) => {
      await sb.setStyle({ style: e.matches ? 'DARK' : 'LIGHT' })
    })
  })
})()
