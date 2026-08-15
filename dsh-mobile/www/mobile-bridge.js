// Mobile bridge: the launcher's single interface to the native layer.
// Node storage rides @capacitor/preferences; connecting opens the remote dsh
// page in a native WebView (DshNative plugin) with the gateway cookie
// pre-injected — no login flash. Health checks and login also ride the native
// layer (no CORS wall from the https:// app scheme to http:// gateways).

(async () => {
  const NODES_KEY = 'dsh-mobile-nodes'
  const LAST_KEY = 'dsh-mobile-last'

  function nativePlugin(name) {
    return window.Capacitor?.Plugins?.[name]
  }

  async function readNodes() {
    const Prefs = nativePlugin('Preferences')
    if (!Prefs) return []
    const { value } = await Prefs.get({ key: NODES_KEY })
    try { return JSON.parse(value ?? '[]') } catch { return [] }
  }

  async function writeNodes(nodes) {
    const Prefs = nativePlugin('Preferences')
    if (!Prefs) return
    await Prefs.set({ key: NODES_KEY, value: JSON.stringify(nodes) })
  }

  window.Bridge = {
    listNodes: () => readNodes(),

    // Reachability probe, resolved per node so the launcher can color dots.
    health: async (id) => {
      const nodes = await readNodes()
      const node = nodes.find((n) => n.id === id)
      const DshNative = nativePlugin('DshNative')
      if (!node || !DshNative) return { status: 'offline' }
      try {
        const r = await DshNative.health({ url: node.url, key: node.key ?? '' })
        return { status: r?.status ?? 'offline' }
      } catch {
        return { status: 'offline' }
      }
    },

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
      const DshNative = nativePlugin('DshNative')
      if (!DshNative) return { error: '当前环境不支持原生 WebView' }
      await nativePlugin('Preferences')?.set({ key: LAST_KEY, value: node.url })

      // 1. Gateway session: same login as the desktop shell (POST
      //    /_gateway/login), performed natively so there is no CORS wall.
      let cookie = null
      if (node.key) {
        const login = await DshNative.login({ url: node.url, key: node.key })
        if (login?.ok && login.cookie) cookie = login.cookie
        console.log('[dsh-mobile] login', login?.ok ? 'ok' : 'failed')
      }

      // 2. Inject the "回到启动页" button script (desktop-proven). The page
      //    calls DshNativeBridge.close() to pop back to the launcher.
      const injectScript = document.getElementById('inject-back-js')?.textContent

      // 3. Open the gateway with the cookie pre-injected — no login flash.
      const openResult = await DshNative.open({
        url: node.url,
        cookieName: 'dsh_gateway_key',
        cookieValue: cookie ?? '',
        injectScript: injectScript ?? '',
      }).catch((e) => ({ error: String(e) }))
      console.log('[dsh-mobile] open', openResult)
      return { ok: !openResult?.error, authed: Boolean(cookie) }
    },
  }

  // ---- status bar: immersive + theme-following ----
  // Capacitor injects the bridge after the page script runs; wait for the
  // ready event explicitly instead of racing DOMContentLoaded.
  function initStatusBar(sb) {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    sb.setOverlaysWebView({ overlay: true }).catch(() => {})
    sb.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {})
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      sb.setStyle({ style: e.matches ? 'DARK' : 'LIGHT' }).catch(() => {})
    })
    console.log('[dsh-mobile] status bar', dark ? 'DARK' : 'LIGHT')
  }

  function whenCapacitorReady(fn) {
    const tryRun = () => {
      const sb = window.Capacitor?.Plugins?.StatusBar
      if (sb) { fn(sb); return true }
      return false
    }
    if (tryRun()) return
    if (window.Capacitor?.addListener) {
      window.Capacitor.addListener('capacitorReady', () => tryRun())
    }
    // Fallback poll: some builds fire ready before plugins resolve.
    let attempts = 0
    const timer = setInterval(() => {
      if (tryRun() || ++attempts > 20) clearInterval(timer)
    }, 250)
  }

  whenCapacitorReady(initStatusBar)
})()
