// dsh-app main process. Flat single-window model: every window is the same
// shell (launcher + per-window WebContentsViews for nodes + settings dialog
// overlay). Connecting in the launcher enters THAT window; the title bar's
// "new window" button opens another identical window, so windows are
// peer-level with independent state. The embedded dsh runtime runs under the
// bundled OFFICIAL node.exe (never Electron's Node — dsh needs Node's
// internal ESM loader API `getOrInitializeCascadedLoader` to resolve
// profile-installed plugins, which Electron's patched kernel lacks).

const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage, nativeTheme, screen } = require('electron')
const path = require('node:path')
const { spawn, exec } = require('node:child_process')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const fs = require('node:fs')
const { createRegistry } = require('./registry')
const { createStore } = require('./store')

const ROOT = __dirname
const DSH_BIN = path.join(ROOT, '.dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const OVERLAY = path.join(ROOT, 'embedded-overlay.yml')
const SHELL_HTML = path.join(ROOT, 'shell.html')
const SETTINGS_HTML = path.join(ROOT, 'settings.html')
const TITLEBAR_HEIGHT = 40

function resolveNodeExe() {
  const bundled = path.join(ROOT, 'resources', 'node.exe')
  if (fs.existsSync(bundled)) return bundled
  return process.env.DSH_NODE ?? 'node'
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function waitForHealth(url, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer)
        reject(new Error(`dsh did not answer ${url} within ${timeoutMs}ms`))
        return
      }
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode === 200) {
          clearInterval(timer)
          resolve()
        }
      })
      req.on('error', () => {})
      req.setTimeout(2000, () => req.destroy())
    }, 500)
  })
}

function killTree(pid) {
  if (!pid) return
  const cmd = process.platform === 'win32'
    ? `taskkill /PID ${pid} /T /F`
    : `kill -9 ${pid}`
  exec(cmd, { windowsHide: true }, () => {})
}

function rgbToHex(value) {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value)
  if (!match) return undefined
  return `#${[1, 2, 3].map((i) => Number(match[i]).toString(16).padStart(2, '0')).join('')}`
}

// ---- embedded local instance ----
let local = null // { child, port, url, logs: string[], ready: boolean }
let registry = null
let shellStore = null

function capture(child, label) {
  const sink = (stream) => stream.on('data', (chunk) => {
    const text = String(chunk)
    if (!local) return
    local.logs.push(text)
    console.log(`[dsh:${label}] ${text.trimEnd()}`)
  })
  sink(child.stdout)
  sink(child.stderr)
}

async function startLocal() {
  if (local && local.child && local.child.exitCode === null) {
    // Already running or still booting — wait until it answers health checks
    // so callers never connect to a half-started server. The spawning caller
    // sets local.ready once healthy; poll it here.
    const deadline = Date.now() + 90_000
    while (local && !local.ready) {
      if (local.child.exitCode !== null || Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (local && local.child && local.child.exitCode === null && local.ready) {
      return { ok: true, port: local.port, url: local.url }
    }
    // fall through: the running instance died or never became healthy — start fresh
  }
  const port = await pickFreePort()
  const url = `http://127.0.0.1:${port}/`
  const child = spawn(resolveNodeExe(), [
    DSH_BIN,
    '--patch', OVERLAY,
    '--profile', 'web',
    '--port', String(port),
  ], {
    env: { ...process.env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  local = { child, port, url, logs: [], ready: false }
  capture(child, 'out')
  capture(child, 'err')
  child.on('exit', (code) => {
    console.log(`[dsh] exited code=${code}`)
    local = null
  })
  try {
    await waitForHealth(url)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (child.exitCode !== null) throw new Error(`dsh exited during startup (code ${child.exitCode})`)
    local.ready = true
    return { ok: true, port, url }
  } catch (error) {
    const logs = local?.logs ?? []
    stopLocal()
    return { ok: false, error: error instanceof Error ? error.message : String(error), logs }
  }
}

function stopLocal() {
  if (local) {
    killTree(local.child.pid)
    local = null
  }
}

// ---- gateway auth ----
const GATEWAY_LOGIN_PATH = '/_gateway/login'
const GATEWAY_COOKIE_NAME = 'dsh_gateway_key'
const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

function ensureGatewaySession(url, key) {
  const parsed = new URL(url)
  const transport = parsed.protocol === 'https:' ? https : http
  const postData = `key=${encodeURIComponent(key)}&next=/`
  return new Promise((resolve) => {
    const req = transport.request({
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: GATEWAY_LOGIN_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(postData),
      },
    }, (res) => {
      const setCookie = res.headers['set-cookie']
      res.resume()
      if (res.statusCode === 302 && Array.isArray(setCookie)) {
        const part = setCookie
          .map((cookie) => cookie.split(';')[0])
          .find((pair) => pair.startsWith(`${GATEWAY_COOKIE_NAME}=`))
        if (part !== undefined) {
          resolve({ ok: true, cookie: part.slice(GATEWAY_COOKIE_NAME.length + 1) })
          return
        }
      }
      if (res.statusCode === 401) resolve({ ok: false, error: '访问密钥无效' })
      else resolve({ ok: false, error: `网关响应异常（${res.statusCode ?? '无响应'}）` })
    })
    req.on('error', (error) => resolve({ ok: false, error: `无法连接网关：${error.message}` }))
    req.setTimeout(8000, () => {
      req.destroy()
      resolve({ ok: false, error: '连接网关超时' })
    })
    req.end(postData)
  })
}

async function setViewCookie(view, url, value) {
  const parsed = new URL(url)
  const session = view.webContents.session
  if (!session) return
  await session.cookies.set({
    url: `${parsed.protocol}//${parsed.host}/`,
    name: GATEWAY_COOKIE_NAME,
    value,
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: parsed.protocol === 'https:',
    expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_MAX_AGE_SECONDS,
  })
}

function checkRemoteHealth(url, key, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      resolve('offline')
      return
    }
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.get({
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: '/',
      headers: { authorization: `Bearer ${key}` },
    }, (res) => {
      res.resume()
      if (res.statusCode === 200) resolve('online')
      else if (res.statusCode === 401) resolve('unauthorized')
      else resolve('offline')
    })
    req.on('error', () => resolve('offline'))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve('offline')
    })
  })
}

// ---- windows: every window is the same shell ----
const appWindows = new Map() // win.id -> state { win, views, activeViewId, dialogView }
let lastThemeTokens = null

function attachDevTools(webContents) {
  webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      webContents.openDevTools({ mode: 'detach' })
    }
  })
}

/** Window state by a sender webContents (chrome, a node view, or the dialog). */
function stateOf(sender) {
  for (const st of appWindows.values()) {
    if (st.win.webContents === sender || st.dialogView?.webContents === sender) return st
    for (const view of st.views.values()) {
      if (view.webContents === sender) return st
    }
  }
  return undefined
}

function viewPartition(id) {
  return id === 'local' ? 'persist:dsh-local' : `persist:dsh-instance-${id}`
}

function layoutViews(st) {
  if (!st.win) return
  const [width, height] = st.win.getContentSize()
  for (const view of st.views.values()) {
    view.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: height - TITLEBAR_HEIGHT })
  }
}

function viewFor(st, id) {
  let view = st.views.get(id)
  if (view === undefined) {
    view = new WebContentsView({
      webPreferences: {
        partition: viewPartition(id),
        preload: path.join(ROOT, 'view-preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    })
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151517' : '#f9fafb')
    st.views.set(id, view)
    st.win.contentView.addChildView(view)
    view.setVisible(false)
    layoutViews(st)
    attachDevTools(view.webContents)
  }
  return view
}

function showView(st, id) {
  const view = viewFor(st, id)
  for (const [key, candidate] of st.views) candidate.setVisible(key === id)
  st.activeViewId = id
  return view
}

function hideAllViews(st) {
  for (const view of st.views.values()) view.setVisible(false)
  st.activeViewId = null
}

/** Current node shown in one window (for its settings dialog). */
function currentFor(st) {
  if (st.activeViewId === 'local') {
    return local ? { type: 'local', name: '本机实例', url: local.url, id: null } : { type: null }
  }
  if (st.activeViewId !== null) {
    const instance = registry?.find(st.activeViewId)
    if (instance !== undefined) return { type: 'remote', name: instance.name, url: instance.url, id: instance.id }
  }
  return { type: null }
}

/** Load a node into one window's view (connect in THAT window). */
async function connectNode(st, id, url, name, key) {
  const view = showView(st, id)
  if (key) {
    const session = await ensureGatewaySession(url, key)
    if (session.ok) await setViewCookie(view, url, session.cookie)
  }
  if (!view.webContents.getURL().startsWith(url)) void view.webContents.loadURL(url).catch(() => {})
  st.win.webContents.send('connection:changed', { name: name || 'dsh' })
}

// ---- settings dialog (per window) ----
function layoutDialogView(st) {
  if (!st.win || !st.dialogView) return
  const [width, height] = st.win.getContentSize()
  st.dialogView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: height - TITLEBAR_HEIGHT })
}

function ensureDialogView(st) {
  if (st.dialogView === null || st.dialogView === undefined) {
    st.dialogView = new WebContentsView({
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    })
    st.dialogView.setBackgroundColor('#00000000')
    st.win.contentView.addChildView(st.dialogView)
    st.dialogView.setVisible(false)
    layoutDialogView(st)
    attachDevTools(st.dialogView.webContents)
  }
  return st.dialogView
}

function openSettings(st) {
  const view = ensureDialogView(st)
  st.win.contentView.removeChildView(view)
  st.win.contentView.addChildView(view)
  view.webContents.loadFile(SETTINGS_HTML).then(() => {
    if (lastThemeTokens) view.webContents.send('theme:sync', lastThemeTokens)
  })
  view.setVisible(true)
}

function closeSettings(st) {
  st.dialogView?.setVisible(false)
}

function createAppWindow() {
  // Each window owns a numbered state slot (1, 2, 3…) so peer windows keep
  // their own size/position across launches. The slot is the smallest number
  // not currently in use — closing window 1 then reopening reuses slot 1, so
  // the primary window's saved bounds come back with it. Bounds are validated
  // against the current display layout — a monitor that went away must not
  // strand the window off-screen.
  const usedSlots = new Set([...appWindows.values()].map((s) => s.slot))
  let slot = 1
  while (usedSlots.has(slot)) slot++
  const saved = shellStore?.get(`winState.${slot}`)
  const bounds = (() => {
    if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return null
    if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return null
    const displays = screen.getAllDisplays()
    const onScreen = displays.some((d) => {
      const a = d.workArea
      // Require a meaningful overlap (title bar reachable) instead of any
      // corner touch, so a mostly-off-screen window is treated as stale.
      const overlapW = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x)
      const overlapH = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y)
      return overlapW >= 80 && overlapH >= 40
    })
    if (!onScreen) return null
    return {
      x: saved.x,
      y: saved.y,
      width: Math.max(saved.width, 800),
      height: Math.max(saved.height, 560),
      maximized: saved.maximized === true,
    }
  })()
  const win = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 800,
    minHeight: 560,
    title: 'dsh app',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#151517',
      symbolColor: '#d7dbe0',
      height: TITLEBAR_HEIGHT,
    },
    backgroundColor: '#151517',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (bounds?.maximized) win.maximize()
  win.loadFile(SHELL_HTML)
  attachDevTools(win.webContents)
  const st = { win, views: new Map(), activeViewId: null, dialogView: null, slot }
  appWindows.set(win.id, st)
  // Persist size/position (debounced; immediate on close). getNormalBounds
  // returns the restored bounds even while maximized, so the slot always
  // records the user's preferred size, not the maximized fill.
  const persistWindowState = () => {
    if (!shellStore || win.isDestroyed()) return
    const b = win.getNormalBounds()
    shellStore.set(`winState.${slot}`, {
      x: b.x, y: b.y, width: b.width, height: b.height,
      maximized: win.isMaximized(),
    })
  }
  let stateTimer = null
  win.on('resize', () => {
    layoutViews(st)
    layoutDialogView(st)
    clearTimeout(stateTimer)
    stateTimer = setTimeout(persistWindowState, 400)
  })
  win.on('move', () => {
    clearTimeout(stateTimer)
    stateTimer = setTimeout(persistWindowState, 400)
  })
  win.on('close', () => {
    clearTimeout(stateTimer)
    persistWindowState()
  })
  win.on('closed', () => appWindows.delete(win.id))
  return st
}

// ---- ipc ----
ipcMain.handle('local:start', () => startLocal())
ipcMain.handle('local:stop', () => { stopLocal(); return { ok: true } })
ipcMain.handle('local:status', () => {
  if (!local || !local.child || local.child.exitCode !== null) return { running: false }
  return local.ready
    ? { running: true, port: local.port, url: local.url }
    : { running: false, starting: true, port: local.port, url: local.url }
})
ipcMain.handle('local:logs', () => local?.logs ?? [])

// Open the local instance in the window that asked.
ipcMain.handle('shell:connect', async (event, url) => {
  const st = stateOf(event.sender)
  if (!st) return { ok: false, error: '窗口不可用' }
  const target = String(url)
  await connectNode(st, 'local', target, 'DeepSeek Harness', '')
  shellStore?.set('lastNode', { type: 'local' })
  return { ok: true }
})

// Connect a remote instance in the window that asked.
ipcMain.handle('remote:connect', async (event, id) => {
  const st = stateOf(event.sender)
  if (!st) return { ok: false, error: '窗口不可用' }
  const instance = registry?.find(String(id))
  if (instance === undefined) return { ok: false, error: '实例不存在' }
  const key = registry.getSecret(instance.id)
  if (key === undefined) return { ok: false, error: '未保存访问密钥，请编辑实例补全' }
  try {
    await connectNode(st, instance.id, instance.url, instance.name, key)
    shellStore?.set('lastNode', { type: 'remote', id: instance.id })
    console.log(`[connect] ok ${instance.url}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// Back to the launcher panel in the window that asked.
ipcMain.handle('shell:back', (event) => {
  const st = stateOf(event.sender)
  if (st) {
    hideAllViews(st)
    st.win.webContents.send('shell:backed')
    st.win.webContents.send('connection:changed', { name: 'DeepSeek Harness' })
  }
  return { ok: true }
})

// Open a brand-new window (peer-level, same shell).
ipcMain.handle('shell:new-window', () => {
  createAppWindow()
  return { ok: true }
})

// Refresh the active view of the window that asked.
ipcMain.handle('view:reload', (event) => {
  const st = stateOf(event.sender)
  if (!st || st.activeViewId === null) return { ok: true }
  st.views.get(st.activeViewId)?.webContents.reload()
  return { ok: true }
})

ipcMain.handle('remote:disconnect', () => ({ ok: true }))
ipcMain.handle('remote:list', () => registry?.view() ?? [])
ipcMain.handle('remote:save', (_event, input) => {
  try {
    return { ok: true, instance: registry.save(input) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})
ipcMain.handle('remote:remove', (_event, id) => {
  registry?.remove(String(id))
  return { ok: true }
})
ipcMain.handle('remote:health', async (_event, id) => {
  const instance = registry?.find(String(id))
  if (instance === undefined) return { status: 'offline' }
  const key = registry.getSecret(instance.id)
  if (key === undefined) return { status: 'unauthorized' }
  return { status: await checkRemoteHealth(instance.url, key) }
})

// Per-window settings dialog.
ipcMain.handle('settings:open', (event) => {
  const st = stateOf(event.sender)
  if (st) openSettings(st)
  return { ok: true }
})
ipcMain.handle('settings:close', (event) => {
  const st = stateOf(event.sender)
  if (st) closeSettings(st)
  return { ok: true }
})
ipcMain.handle('settings:current', (event) => currentFor(stateOf(event.sender)))
ipcMain.handle('settings:get-login-item', () => app.getLoginItemSettings().openAtLogin === true)
ipcMain.handle('settings:set-login-item', (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled === true })
  return { ok: true }
})
ipcMain.handle('settings:get-restore', () => shellStore?.get('restoreLastNode') === true)
ipcMain.handle('settings:set-restore', (_event, enabled) => {
  shellStore?.set('restoreLastNode', enabled === true)
  return { ok: true }
})
ipcMain.handle('settings:get-auto-local', () => shellStore?.get('autoStartLocal') === true)
ipcMain.handle('settings:set-auto-local', (_event, enabled) => {
  shellStore?.set('autoStartLocal', enabled === true)
  return { ok: true }
})

ipcMain.handle('win:minimize', (event) => {
  stateOf(event.sender)?.win.minimize()
  return { ok: true }
})
ipcMain.handle('win:toggle-maximize', (event) => {
  const win = stateOf(event.sender)?.win
  if (!win) return { ok: true }
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
  return { ok: true }
})
ipcMain.handle('win:close', (event) => {
  stateOf(event.sender)?.win.close()
  return { ok: true }
})
ipcMain.handle('win:is-maximized', (event) => stateOf(event.sender)?.win.isMaximized() ?? false)

// ---- theme sync (per window) ----
ipcMain.on('theme:changed', (event, tokens) => {
  const st = stateOf(event.sender)
  if (!st) return
  lastThemeTokens = tokens
  const bg = tokens['--dsw-alias-bg-base']
  const fg = tokens['--dsw-alias-label-primary']
  if (typeof bg === 'string' && typeof fg === 'string') {
    st.win.setTitleBarOverlay({
      color: rgbToHex(bg),
      symbolColor: rgbToHex(fg),
      height: TITLEBAR_HEIGHT,
    })
  }
  st.win.webContents.send('theme:sync', tokens)
  st.dialogView?.webContents.send('theme:sync', tokens)
})

// ---- lifecycle ----
app.whenReady().then(() => {
  registry = createRegistry(app.getPath('userData'), safeStorage)
  shellStore = createStore(app.getPath('userData'))
  const main = createAppWindow()

  const enterLocal = async (st) => {
    // Show the view immediately (dark loading ground) so restoring the local
    // instance never sits on the launcher while dsh boots.
    showView(st, 'local')
    const result = await startLocal()
    if (result.ok) {
      await connectNode(st, 'local', result.url, 'DeepSeek Harness', '')
    }
  }

  if (process.env.DSH_AUTOSTART === '1') {
    if (process.env.DSH_REMOTE_URL) {
      const key = process.env.DSH_REMOTE_KEY ?? ''
      connectNode(main, 'adhoc', process.env.DSH_REMOTE_URL, new URL(process.env.DSH_REMOTE_URL).host, key)
        .then(() => console.log('[remote] connected'))
    } else {
      void enterLocal(main)
    }
  } else {
    if (shellStore.get('autoStartLocal') === true) {
      startLocal().then((result) => {
        if (result.ok) console.log(`[auto-local] running ${result.url}`)
      })
    }
    if (shellStore.get('restoreLastNode') === true) {
      const last = shellStore.get('lastNode')
      if (last?.type === 'remote' && typeof last.id === 'string') {
        const instance = registry?.find(last.id)
        if (instance) {
          const key = registry.getSecret(instance.id)
          if (key) {
            connectNode(main, instance.id, instance.url, instance.name, key)
              .then(() => console.log(`[restore] connected ${instance.url}`))
          }
        }
      } else if (last?.type === 'local') {
        void enterLocal(main)
      }
    }
  }
})

app.on('window-all-closed', () => {
  stopLocal()
  app.quit()
})
app.on('will-quit', () => {
  stopLocal()
})
