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
      // system keystore); kept here for the desktop mock parity.
      if (input.key) record.key = input.key
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
      if (!InAppBrowser) return { error: '当前环境不支持内嵌浏览器' }
      await Prefs?.set({ key: LAST_KEY, value: node.url })
      await InAppBrowser.openInWebView({
        url: node.url,
        options: {
          showURL: true,
          showToolbar: true,
          closeButtonText: '返回',
          mediaPlaybackRequiresUserAction: true,
          android: {
            allowZoom: true,
            hardwareBack: true,
            pauseMedia: false,
            isIsolated: false,
          },
          iOS: {
            allowOverScroll: false,
            enableViewportScale: false,
            allowInLineMediaPlayback: false,
            surpressIncrementalRendering: false,
            viewStyle: 2, // FULL_SCREEN
            animationEffect: 0,
            allowsBackForwardNavigationGestures: true,
          },
        },
        // Gateway session: POST /_gateway/login answers Set-Cookie
        // dsh_gateway_key=...; the WebView lands on the login page on the
        // same origin, so the cookie sticks and the app proceeds. A future
        // build can pre-authenticate and pass the cookie here as a header.
        customHeaders: node.key ? { Authorization: `Bearer ${node.key}` } : {},
      })
      return { ok: true }
    },
  }
})()
