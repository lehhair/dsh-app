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
const { startRemoteProxy, stopRemoteProxy, parseTarget } = require('./proxy')
const { createRegistry } = require('./registry')

const ROOT = __dirname
const DSH_BIN = path.join(ROOT, '.dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const OVERLAY = path.join(ROOT, 'embedded-overlay.yml')
const SHELL_HTML = path.join(ROOT, 'shell.html')
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
let remote = null // { port, url } — loopback proxy for a remote node
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

/** Stop the remote-node loopback proxy, if one is running. */
async function disconnectRemote() {
  if (remote) {
    stopRemoteProxy(remote)
    remote = null
  }
}

/**
 * Connect the dsh view to a remote node through a loopback proxy that
 * injects the gateway key (Bearer) on every request, WebSocket upgrades
 * included.
 */
async function connectRemote(rawUrl, rawKey) {
  const url = String(rawUrl ?? '').trim()
  const key = String(rawKey ?? '')
  if (!/^https?:\/\/[^/]+$/.test(url)) return { ok: false, error: '无效的地址，形如 http://192.168.1.233:8443' }
  if (key.length === 0) return { ok: false, error: '缺少访问密钥' }
  try {
    await disconnectRemote()
    const { port } = await startRemoteProxy(url, key)
    const localUrl = `http://127.0.0.1:${port}/`
    remote = { port, url: localUrl }
    await dshView.webContents.loadURL(localUrl)
    dshView.setVisible(true)
    return { ok: true, url: localUrl }
  } catch (error) {
    await disconnectRemote()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Connect by registry id (resolves the stored URL + decrypted key). */
async function connectById(id) {
  const instance = registry?.find(id)
  if (instance === undefined) return { ok: false, error: '实例不存在' }
  const key = registry.getSecret(id)
  if (key === undefined) return { ok: false, error: '未保存访问密钥，请编辑实例补全' }
  return connectRemote(instance.url, key)
}

/** Probe one remote gateway's health with its stored key. */
async function checkRemoteHealth(url, key, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let target
    try {
      target = parseTarget(url)
    } catch {
      resolve('offline')
      return
    }
    const transport = target.protocol === 'https' ? https : http
    const req = transport.get({
      host: target.host,
      port: target.port,
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

// ---- window: frameless shell UI + WebContentsView for the dsh page ----
let shellWindow = null
let dshView = null

/** F12 opens DevTools for the given webContents (dev aid for both pages). */
function attachDevTools(webContents) {
  webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      webContents.openDevTools({ mode: 'detach' })
    }
  })
}

function layoutDshView() {
  if (!shellWindow || !dshView) return
  const [width, height] = shellWindow.getContentSize()
  dshView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: height - TITLEBAR_HEIGHT })
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

  // The connected dsh web renders here, below the title bar; the shell UI
  // (title bar + launcher panel) stays in the window's own webContents.
  // view-preload.js only samples the page's effective CSS tokens and ships
  // them to the shell for title-bar fusion — it exposes no API to the page.
  dshView = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, 'view-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  shellWindow.contentView.addChildView(dshView)
  dshView.setVisible(false)
  layoutDshView()
  attachDevTools(dshView.webContents)

  // Forward sampled theme tokens to the shell UI (theme sync / fusion),
  // and keep the OS-rendered window controls on the same palette.
  ipcMain.on('theme:changed', (_event, tokens) => {
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

  shellWindow.on('resize', layoutDshView)
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

// Connect the dsh view to a URL and bring it over the launcher panel.
ipcMain.handle('shell:connect', async (_event, url) => {
  const target = String(url)
  if (!dshView) return { ok: false, error: 'view unavailable' }
  await dshView.webContents.loadURL(target)
  dshView.setVisible(true)
  return { ok: true }
})

// Back to the launcher panel (hides the dsh view; stops a remote proxy).
ipcMain.handle('shell:back', async () => {
  await disconnectRemote()
  dshView?.setVisible(false)
  return { ok: true }
})

// Remote node connection (loopback proxy injecting Bearer).
ipcMain.handle('remote:connect', (_event, id) => connectById(String(id)))
ipcMain.handle('remote:disconnect', async () => {
  await disconnectRemote()
  dshView?.setVisible(false)
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
  registry?.remove(String(id))
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
          await dshView.webContents.loadURL(result.url)
          dshView.setVisible(true)
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
  void disconnectRemote()
})
