// dsh-app main process: the Electron shell owns windows, process
// lifecycle, and the launcher; the embedded dsh runtime runs under the
// bundled OFFICIAL node.exe (never Electron's Node — dsh needs Node's
// internal ESM loader API `getOrInitializeCascadedLoader` to resolve
// profile-installed plugins, which Electron's patched kernel lacks).
//
// Window structure: frameless BrowserWindow running the shell UI (custom
// title bar + launcher panel); the connected dsh web renders in a
// WebContentsView laid out below the title bar, so the remote page keeps a
// full, unoccluded viewport ("renders exactly like dsh web").
//
// Embedded run:  node.exe lib/bin.js --patch <overlay> --profile web --port <free>
// Remote nodes (local proxy injecting Bearer) land in a later phase.

const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage } = require('electron')
const path = require('node:path')
const { spawn, exec } = require('node:child_process')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const fs = require('node:fs')
const { createRegistry } = require('./registry')

const ROOT = __dirname
const DSH_BIN = path.join(ROOT, '.dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const OVERLAY = path.join(ROOT, 'embedded-overlay.yml')
const SHELL_HTML = path.join(ROOT, 'shell.html')
const SETTINGS_HTML = path.join(ROOT, 'settings.html')
const TITLEBAR_HEIGHT = 40

/** The node.exe that runs the embedded dsh: bundled in packaged builds, system PATH in dev. */
function resolveNodeExe() {
  const bundled = path.join(ROOT, 'resources', 'node.exe')
  if (fs.existsSync(bundled)) return bundled
  return process.env.DSH_NODE ?? 'node'
}

/** Pick a free TCP port on loopback (dsh binds it; avoids squabbling with system dsh on 3080). */
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

/** Poll a URL until HTTP 200 or timeout. */
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

/** Kill a process tree (Windows taskkill /T, else kill -9). */
function killTree(pid) {
  if (!pid) return
  const cmd = process.platform === 'win32'
    ? `taskkill /PID ${pid} /T /F`
    : `kill -9 ${pid}`
  exec(cmd, { windowsHide: true }, () => {})
}

/** Convert a computed `rgb(r, g, b)` (or `rgba`) string to #rrggbb for setTitleBarOverlay. */
function rgbToHex(value) {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value)
  if (!match) return undefined
  return `#${[1, 2, 3].map((i) => Number(match[i]).toString(16).padStart(2, '0')).join('')}`
}

// ---- embedded local instance state ----
let local = null // { child, port, url, logs: string[] }
let registry = null // remote-node registry (instances + encrypted keys)

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
    return { ok: true, port: local.port, url: local.url }
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
  local = { child, port, url, logs: [] }
  capture(child, 'out')
  capture(child, 'err')
  child.on('exit', (code, signal) => {
    console.log(`[dsh] exited code=${code} signal=${signal}`)
    local = null
    shellWindow?.webContents.send('local:exited', { code })
  })
  try {
    await waitForHealth(url)
    // Health 200 can race the plugin tree; confirm the process survived.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (child.exitCode !== null) throw new Error(`dsh exited during startup (code ${child.exitCode})`)
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

/** The gateway login path and session cookie name (remote-gateway defaults). */
const GATEWAY_LOGIN_PATH = '/_gateway/login'
const GATEWAY_COOKIE_NAME = 'dsh_gateway_key'
const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/**
 * Pre-login to a remote gateway: POST the key, capture the Set-Cookie
 * session, so the view can load the gateway origin with the cookie already
 * in place (no login-page flash, and fetch + WebSocket both carry it).
 */
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

/** Write the gateway session cookie into a view's (partition-isolated) session. */
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

/**
 * Connect the dsh view to a remote node directly (no proxy layer): pre-login
 * to the gateway, plant the session cookie in that instance's own partition,
 * load the gateway origin. The origin is stable, so Chromium's disk cache
 * applies naturally; different instances never share cookies.
 */
async function connectRemote(rawUrl, rawKey) {
  const url = String(rawUrl ?? '').trim()
  const key = String(rawKey ?? '')
  if (!/^https?:\/\/[^/]+$/.test(url)) return { ok: false, error: '无效的地址，形如 http://192.168.1.233:8443' }
  if (key.length === 0) return { ok: false, error: '缺少访问密钥' }
  try {
    const session = await ensureGatewaySession(url, key)
    if (!session.ok) return session
    const view = viewFor('adhoc')
    await setViewCookie(view, url, session.cookie)
    showView('adhoc')
    if (!view.webContents.getURL().startsWith(url)) void view.webContents.loadURL(url)
    shellWindow?.webContents.send('connection:changed', { name: new URL(url).host })
    return { ok: true, url }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Connect by registry id. Each instance owns a partition-isolated view, so
 * two instances at the SAME URL with DIFFERENT keys keep separate sessions.
 * Re-entering an already-loaded instance just reveals its view.
 */
async function connectById(id) {
  console.log(`[connect] id=${id}`)
  const instance = registry?.find(id)
  if (instance === undefined) return { ok: false, error: '实例不存在' }
  const key = registry.getSecret(id)
  if (key === undefined) return { ok: false, error: '未保存访问密钥，请编辑实例补全' }
  try {
    const session = await ensureGatewaySession(instance.url, key)
    if (!session.ok) {
      console.log(`[connect] session failed: ${session.error}`)
      return session
    }
    const view = viewFor(id)
    await setViewCookie(view, instance.url, session.cookie)
    const alreadyLoaded = view.webContents.getURL().startsWith(instance.url)
    // Reveal immediately (dark ground + the page's own loading UI), then
    // load without blocking the click: no dead seconds on the launcher.
    showView(id)
    if (!alreadyLoaded) void view.webContents.loadURL(instance.url)
    shellWindow?.webContents.send('connection:changed', { name: instance.name })
    console.log(`[connect] ok ${instance.url} cached=${alreadyLoaded}`)
    return { ok: true, url: instance.url, cached: alreadyLoaded }
  } catch (error) {
    console.log(`[connect] error: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Probe one remote gateway's health with its stored key. */
async function checkRemoteHealth(url, key, timeoutMs = 5000) {
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

// ---- window: frameless shell UI + per-instance WebContentsViews ----
let shellWindow = null
const views = new Map() // 'local' | instanceId | 'adhoc' -> WebContentsView
let activeViewId = null // which view is currently shown

/** F12 opens DevTools for the given webContents (dev aid for both pages). */
function attachDevTools(webContents) {
  webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      webContents.openDevTools({ mode: 'detach' })
    }
  })
}

/**
 * Per-instance session partition: cookies and cache are isolated per node.
 * Two instances pointing at the SAME gateway URL with DIFFERENT keys get
 * separate cookie stores — no cross-talk (the previous single-view scheme
 * shared one origin cookie and overwrote each other's session).
 */
function viewPartition(id) {
  return id === 'local' ? 'persist:dsh-local' : `persist:dsh-instance-${id}`
}

function layoutViews() {
  if (!shellWindow) return
  const [width, height] = shellWindow.getContentSize()
  for (const view of views.values()) {
    view.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: height - TITLEBAR_HEIGHT })
  }
  if (dialogView) dialogView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: height - TITLEBAR_HEIGHT })
}

/** Get (creating on demand) the WebContentsView for one target. */
function viewFor(id) {
  let view = views.get(id)
  if (view === undefined) {
    view = new WebContentsView({
      webPreferences: {
        partition: viewPartition(id),
        preload: path.join(ROOT, 'view-preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    })
    // Register BEFORE layoutViews: it iterates the Map to size each view,
    // so a not-yet-registered view would keep 0x0 bounds and never show.
    views.set(id, view)
    // Dark ground while a page loads: never a glaring white flash.
    view.setBackgroundColor('#151517')
    shellWindow.contentView.addChildView(view)
    view.setVisible(false)
    layoutViews()
    attachDevTools(view.webContents)
  }
  return view
}

/** Show one target's view (hiding all others). */
function showView(id) {
  const view = viewFor(id)
  for (const [key, candidate] of views) candidate.setVisible(key === id)
  activeViewId = id
  return view
}

function hideAllViews() {
  for (const view of views.values()) view.setVisible(false)
  activeViewId = null
}

function createWindow() {
  shellWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    title: 'dsh app',
    // Windows-native window controls rendered by the OS (VS Code style):
    // standard minimize/maximize/close that can never look off-brand.
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
  shellWindow.loadFile(SHELL_HTML)
  attachDevTools(shellWindow.webContents)

  // Forward sampled theme tokens ONLY from the currently shown view (hidden
  // views keep sampling but must not override the visible page's palette).
  ipcMain.on('theme:changed', (event, tokens) => {
    const active = activeViewId ? views.get(activeViewId) : undefined
    if (active === undefined || event.sender !== active.webContents) return
    console.log(`[theme] synced ${Object.keys(tokens).length} tokens`)
    const bg = tokens['--dsw-alias-bg-base']
    const fg = tokens['--dsw-alias-label-primary']
    if (shellWindow && typeof bg === 'string' && typeof fg === 'string') {
      shellWindow.setTitleBarOverlay({
        color: rgbToHex(bg),
        symbolColor: rgbToHex(fg),
        height: TITLEBAR_HEIGHT,
      })
    }
    shellWindow?.webContents.send('theme:sync', tokens)
  })

  shellWindow.on('resize', layoutViews)
  shellWindow.on('maximize', () => shellWindow?.webContents.send('win:maximized-changed', true))
  shellWindow.on('unmaximize', () => shellWindow?.webContents.send('win:maximized-changed', false))
  shellWindow.on('closed', () => { shellWindow = null })
}

// ---- ipc (launcher only; preload gates on file: origin) ----
ipcMain.handle('local:start', () => startLocal())
ipcMain.handle('local:stop', () => { stopLocal(); return { ok: true } })
ipcMain.handle('local:status', () => local
  ? { running: true, port: local.port, url: local.url }
  : { running: false })
ipcMain.handle('local:logs', () => local?.logs ?? [])

// Connect the dsh view to a URL (local embedded instance) and show it.
// Reusing the same view without reload when it already shows that target.
ipcMain.handle('shell:connect', async (_event, url) => {
  const target = String(url)
  const view = viewFor('local')
  showView('local')
  if (!view.webContents.getURL().startsWith(target)) void view.webContents.loadURL(target)
  shellWindow?.webContents.send('connection:changed', { name: 'DeepSeek Harness' })
  return { ok: true }
})

// Refresh the currently shown dsh view.
ipcMain.handle('view:reload', () => {
  const active = activeViewId ? views.get(activeViewId) : undefined
  active?.webContents.reload()
  return { ok: true }
})

// Back to the launcher panel: hide every view. Embedded process stays alive
// so re-entering is fast (page + per-instance disk cache kept).
ipcMain.handle('shell:back', () => {
  hideAllViews()
  shellWindow?.webContents.send('shell:backed')
  shellWindow?.webContents.send('connection:changed', { name: 'DeepSeek Harness' })
  return { ok: true }
})

// Remote node connection (direct gateway origin, pre-login session cookie).
ipcMain.handle('remote:connect', (_event, id) => connectById(String(id)))
ipcMain.handle('remote:disconnect', () => {
  hideAllViews()
  shellWindow?.webContents.send('connection:changed', { name: 'DeepSeek Harness' })
  return { ok: true }
})

// Remote-node registry (keys stay in the main process; views are redacted).
ipcMain.handle('remote:list', () => registry?.view() ?? [])
ipcMain.handle('remote:save', (_event, input) => {
  try {
    return { ok: true, instance: registry.save(input) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})
ipcMain.handle('remote:remove', (_event, id) => {
  const instanceId = String(id)
  const view = views.get(instanceId)
  if (view) {
    shellWindow.contentView.removeChildView(view)
    views.delete(instanceId)
  }
  if (activeViewId === instanceId) activeViewId = null
  registry?.remove(instanceId)
  return { ok: true }
})
ipcMain.handle('remote:set-default', (_event, id) => {
  try {
    registry?.setDefault(String(id))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})
ipcMain.handle('remote:health', async (_event, id) => {
  const instance = registry?.find(String(id))
  if (instance === undefined) return { status: 'offline' }
  const key = registry.getSecret(instance.id)
  if (key === undefined) return { status: 'unauthorized' }
  return { status: await checkRemoteHealth(instance.url, key) }
})

// Custom title bar window controls.
ipcMain.handle('win:minimize', () => { shellWindow?.minimize(); return { ok: true } })
ipcMain.handle('win:toggle-maximize', () => {
  if (!shellWindow) return { ok: true }
  if (shellWindow.isMaximized()) shellWindow.unmaximize()
  else shellWindow.maximize()
  return { ok: true }
})
ipcMain.handle('win:close', () => { shellWindow?.close(); return { ok: true } })
ipcMain.handle('win:is-maximized', () => shellWindow?.isMaximized() ?? false)

// ---- settings dialog overlay (transparent WebContentsView above the views) ----
let dialogView = null

function ensureDialogView() {
  if (dialogView === null) {
    dialogView = new WebContentsView({
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    })
    dialogView.setBackgroundColor('#00000000')
    shellWindow.contentView.addChildView(dialogView)
    dialogView.setVisible(false)
    layoutDialogView()
    attachDevTools(dialogView.webContents)
  }
  return dialogView
}

function layoutDialogView() {
  if (!shellWindow || !dialogView) return
  const [width, height] = shellWindow.getContentSize()
  dialogView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: height - TITLEBAR_HEIGHT })
}

function openSettings() {
  const view = ensureDialogView()
  // Re-add so the dialog draws above every instance view, then load fresh.
  shellWindow.contentView.removeChildView(view)
  shellWindow.contentView.addChildView(view)
  view.webContents.loadFile(SETTINGS_HTML)
  view.setVisible(true)
}

function closeSettings() {
  dialogView?.setVisible(false)
}

/** What the settings dialog should show as the current connection. */
function currentConnection() {
  if (activeViewId === 'local') {
    return local ? { type: 'local', name: '本机实例', url: local.url } : { type: null }
  }
  if (activeViewId !== null) {
    const instance = registry?.find(activeViewId)
    if (instance !== undefined) return { type: 'remote', name: instance.name, url: instance.url }
  }
  return { type: null }
}

ipcMain.handle('settings:open', () => { openSettings(); return { ok: true } })
ipcMain.handle('settings:close', () => { closeSettings(); return { ok: true } })
ipcMain.handle('settings:current', () => currentConnection())
ipcMain.handle('settings:get-login-item', () => app.getLoginItemSettings().openAtLogin === true)
ipcMain.handle('settings:set-login-item', (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled === true })
  return { ok: true }
})

// ---- lifecycle ----
app.whenReady().then(() => {
  registry = createRegistry(app.getPath('userData'), safeStorage)
  createWindow()
  if (process.env.DSH_AUTOSTART === '1') {
    // DSH_REMOTE_URL [+ DSH_REMOTE_KEY] boots straight into a remote node;
    // otherwise boot the embedded local instance.
    if (process.env.DSH_REMOTE_URL) {
      connectRemote(process.env.DSH_REMOTE_URL, process.env.DSH_REMOTE_KEY ?? '').then((result) => {
        console.log(`[remote] ${result.ok ? `connected ${result.url}` : `failed: ${result.error}`}`)
      })
    } else {
      startLocal().then(async (result) => {
        if (result.ok) {
          const view = showView('local')
          await view.webContents.loadURL(result.url)
        }
      })
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
