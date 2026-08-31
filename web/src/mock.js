// Browser-preview mock of the Tauri bridge. When `web/dist` is served
// standalone (no Tauri runtime), bridge.js swaps in this mock so the
// launcher page renders with believable fake state and every control stays
// interactive — used for UI review without compiling the app.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const j = (value) => Promise.resolve(structuredClone(value))
const noop = () => Promise.resolve(() => {})

// ?mobile=1 previews the phone layout: appInfo reports Android, the page
// drops the local-instance section + titlebar, and a fake status-bar inset
// is applied — pair it with the browser's device toolbar for the frame.
const previewMobile =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('mobile')

const state = {
  running: false,
  starting: false,
  port: 54150,
  version: '0.1.0-rc.6',
  registry: 'https://registry.npmmirror.com',
  restore: true,
  autoLocal: false,
  instances: [
    { id: 'home', name: '书房网关', url: 'http://192.168.1.233:8443', keyConfigured: true },
    { id: 'office', name: '公司服务器', url: 'http://10.0.8.12:8443', keyConfigured: false },
  ],
  logs: [
    'remote gateway: http://127.0.0.1:8443 (LAN: http://192.168.47.1:8443)',
    'dsh web: http://127.0.0.1:54150',
  ],
  updateListeners: [],
}

const emitUpdateLog = (line) => state.updateListeners.forEach((cb) => cb(line))
const localUrl = () => `http://127.0.0.1:${state.port}/`

async function fakeInstall(target) {
  emitUpdateLog(`正在安装 @deepseek-ai/dsh@${target} …`)
  for (const line of [' resolving metadata…', ' downloading tarball…', ' linking dependencies…']) {
    await delay(420)
    emitUpdateLog(line)
  }
  state.version = target
  emitUpdateLog(`安装完成：v${target}`)
  return { ok: true, version: target, error: null }
}

export const mockBridge = {
  appInfo: () =>
    j({
      desktop: !previewMobile,
      version: '0.3.1',
      bundled: false,
      platform: previewMobile ? 'android' : 'windows',
    }),
  statusBarHeight: () => j(previewMobile ? 24 : 0),

  startLocal: async () => {
    state.starting = true
    await delay(900)
    state.starting = false
    state.running = true
    return { ok: true, running: true, starting: false, port: state.port, url: localUrl() }
  },
  stopLocal: async () => {
    state.running = false
    return { ok: true }
  },
  status: () =>
    j({
      running: state.running,
      starting: state.starting,
      port: state.running ? state.port : null,
      url: state.running ? localUrl() : null,
    }),
  logs: () => j(state.logs.join('\n')),

  dshVersion: () => j(state.version),
  diagnose: () => j('[mock] 浏览器预览，无真实解析链'),
  checkUpdate: async () => {
    await delay(650)
    return { current: state.version, latest: '0.1.1-rc.2', updateAvailable: state.version !== '0.1.1-rc.2' }
  },
  update: (target) => fakeInstall(target),
  install: () => fakeInstall('0.1.1-rc.2'),
  cancelUpdate: () => j({ ok: true, cancelled: true }),
  onUpdateLog: (callback) => {
    state.updateListeners.push(callback)
    return Promise.resolve(() => {})
  },

  checkLauncherUpdate: () =>
    j({ updateAvailable: true, version: '0.3.2', url: null, size: null, notes: null, sha256: null }),
  launcherUpdate: () => j({ ok: true }),
  onExited: noop,
  onBacked: noop,

  connect: () => j({ ok: true }),
  back: () => j({ ok: true }),
  newWindow: () => j({ ok: true }),
  shellReady: () => j({ ok: true }),
  reload: () => j({ ok: true }),
  openDevTools: () => j({ ok: true }),
  onConnectionChanged: noop,

  remote: {
    connect: () => j({ ok: true }),
    list: () => j(state.instances),
    save: async (input) => {
      const id = input.id ?? `inst-${Date.now()}`
      const existing = state.instances.find((inst) => inst.id === id)
      const record = {
        id,
        name: input.name || '未命名',
        url: input.url || '',
        keyConfigured: input.key ? true : (existing?.keyConfigured ?? false),
      }
      if (existing) Object.assign(existing, record)
      else state.instances.push(record)
      return { ok: true, instance: structuredClone(record) }
    },
    remove: async (id) => {
      state.instances = state.instances.filter((inst) => inst.id !== id)
      return { ok: true }
    },
    health: () => j({ status: 'online' }),
  },

  registry: {
    get: () => j({ registry: state.registry, default: 'https://registry.npmjs.org/' }),
    set: async (url) => {
      state.registry = url
      return { ok: true }
    },
  },

  settings: {
    open: () => j({ ok: true }),
    close: () => j({ ok: true }),
    current: () => j({ connected: false }),
    getLoginItem: () => j(false),
    setLoginItem: () => j({ ok: true }),
    getRestore: () => j(state.restore),
    setRestore: async (enabled) => {
      state.restore = enabled
      return { ok: true }
    },
    getAutoLocal: () => j(state.autoLocal),
    setAutoLocal: async (enabled) => {
      state.autoLocal = enabled
      return { ok: true }
    },
  },
  onSettingsRefresh: noop,
  onThemeSync: noop,

  window: {
    minimize: () => {},
    toggleMaximize: async () => {},
    close: () => {},
    isMaximized: () => j(false),
    onMaximizedChanged: (callback) => {
      callback(false)
      return Promise.resolve(() => {})
    },
  },
}
