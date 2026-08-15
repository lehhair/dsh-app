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

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const path = require('node:path')
const { spawn, exec } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')

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

// ---- embedded local instance state ----
let local = null // { child, port, url, logs: string[] }

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

// ---- window: frameless shell UI + WebContentsView for the dsh page ----
let shellWindow = null
let dshView = null

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
    frame: false,
    backgroundColor: '#151517',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  shellWindow.loadFile(SHELL_HTML)

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

  // Forward sampled theme tokens to the shell UI (theme sync / fusion).
  ipcMain.on('theme:changed', (_event, tokens) => {
    console.log(`[theme] synced ${Object.keys(tokens).length} tokens`)
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

// Back to the launcher panel (hides the dsh view).
ipcMain.handle('shell:back', () => {
  dshView?.setVisible(false)
  return { ok: true }
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
  createWindow()
  if (process.env.DSH_AUTOSTART === '1') {
    startLocal().then(async (result) => {
      if (result.ok) {
        await dshView.webContents.loadURL(result.url)
        dshView.setVisible(true)
      }
    })
  }
})

app.on('window-all-closed', () => {
  stopLocal()
  app.quit()
})
app.on('will-quit', () => stopLocal())
