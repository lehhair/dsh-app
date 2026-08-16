// Launcher page logic — the direct port of the Electron shell inline script,
// with the Electron preload calls replaced by the `bridge` wrapper and the
// OS-rendered titlebar controls replaced by our own min/max/close buttons.

import { bridge } from './bridge.js'

// ---- dsh alias token -> shell variable map (theme fusion) ----
const TOKEN_MAP = {
  '--dsw-alias-bg-base': '--shell-bg',
  '--dsw-alias-bg-layer-1': '--shell-layer',
  '--dsw-alias-bg-layer-2': '--shell-layer-2',
  '--dsw-alias-label-primary': '--shell-fg',
  '--dsw-alias-label-primary-foreground': '--shell-fg-foreground',
  '--dsw-alias-label-secondary': '--shell-fg-secondary',
  '--dsw-alias-label-tertiary': '--shell-fg-tertiary',
  '--dsw-alias-border-l2': '--shell-border',
  '--dsw-alias-interactive-bg-hover': '--shell-hover',
  '--dsw-alias-interactive-bg-active': '--shell-active',
  '--dsw-alias-button-primary-fill': '--shell-brand',
  '--dsw-alias-button-primary-hover': '--shell-brand-hover',
  '--dsw-alias-button-ghost-active-fill': '--shell-ghost-fill',
  '--dsw-alias-button-ghost-active-border': '--shell-ghost-border',
  '--dsw-alias-scrollbar-bg-l1': '--shell-scrollbar-thumb',
  '--dsw-alias-scrollbar-hover-l1': '--shell-scrollbar-thumb-hover',
  '--dsw-alias-state-error-primary': '--shell-danger',
  '--dsw-alias-state-success-primary': '--shell-success',
}
bridge.onThemeSync((tokens) => {
  const root = document.documentElement
  for (const [alias, value] of Object.entries(tokens)) {
    const target = TOKEN_MAP[alias]
    if (target && value) root.style.setProperty(target, value)
  }
})

const badge = document.getElementById('badge')
const meta = document.getElementById('meta')
const log = document.getElementById('log')
const startBtn = document.getElementById('start')
const stopBtn = document.getElementById('stop')
const openBtn = document.getElementById('open')
const settingsBtn = document.getElementById('settings')
const reloadBtn = document.getElementById('reload')
const titleStatus = document.getElementById('title-status')

let current = null // { port, url }
// External flavor: the dsh runtime is the user's own global install — the
// shell cannot update it, so the in-app dsh updater is hidden.
let external = false

function setBadge(state, text) {
  badge.textContent = ''
  if (state === 'ongoing') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 10 10')
    svg.setAttribute('shape-rendering', 'crispEdges')
    // dsh chase: 8 outer cells of a 3x3 matrix, clockwise from top-left;
    // negative per-cell delay phases the trail so the bright cell runs
    // around instead of all cells blinking in sync.
    const cells = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]]
    cells.forEach(([x, y], index) => {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', x)
      rect.setAttribute('y', y)
      rect.setAttribute('width', 2)
      rect.setAttribute('height', 2)
      rect.style.animationDelay = `${(index - cells.length) * 125}ms`
      svg.appendChild(rect)
    })
    badge.appendChild(svg)
  } else if (state === 'done' || state === 'error') {
    const dot = document.createElement('span')
    // `danger`, not `error`: `.error` collides with the generic message
    // style (min-height: 20px) and shears the dot into an ellipse.
    dot.className = state === 'error' ? 'dot danger' : 'dot done'
    badge.appendChild(dot)
  }
  badge.appendChild(document.createTextNode(text))
  badge.classList.toggle('on', state === 'done')
}

// status: 'idle' | 'starting' | 'running' | 'error'
function setState(status, port, url) {
  current = status === 'running' ? { port, url } : null
  if (status === 'running') setBadge('done', '运行中')
  else if (status === 'starting') setBadge('ongoing', '启动中')
  else if (status === 'error') setBadge('error', '启动失败')
  else setBadge(null, '已停止')
  meta.textContent = status === 'running' ? `http://127.0.0.1:${port}/`
    : status === 'starting' ? '正在启动…'
    : '未启动'
  const running = status === 'running'
  stopBtn.disabled = !running
  openBtn.disabled = !running
  startBtn.disabled = running || status === 'starting'
}

async function refresh() {
  const s = await bridge.status()
  setState(s.starting ? 'starting' : s.running ? 'running' : 'idle', s.port, s.url)
  if (s.running) {
    const logs = await bridge.logs()
    log.hidden = false
    log.textContent = logs.join('\n').slice(-4000)
    log.scrollTop = log.scrollHeight
  }
}

startBtn.addEventListener('click', async () => {
  setState('starting')
  let result
  try {
    result = await bridge.startLocal()
  } catch (e) {
    // A real failure rejects the invoke (Err(String)); the message goes into
    // the boot log next to the dsh output.
    setState('error')
    log.hidden = false
    log.textContent = `${e || '启动失败'}\n${(await bridge.logs().catch(() => [])).join('\n').slice(-4000)}`
    return
  }
  if (result.ok) {
    setState('running', result.port, result.url)
    log.hidden = false
    log.textContent = (await bridge.logs()).join('\n').slice(-4000)
  } else {
    setState('error')
    log.hidden = false
    log.textContent = `启动失败\n${(await bridge.logs().catch(() => [])).join('\n').slice(-4000)}`
  }
})

stopBtn.addEventListener('click', async () => {
  await bridge.stopLocal()
  setState('idle')
})

openBtn.addEventListener('click', async () => {
  if (!current) return
  await bridge.connect(current.url)
})

// title-bar refresh reloads the currently shown dsh page
reloadBtn.addEventListener('click', () => bridge.reload())

// title-bar new-window opens a peer shell window
document.getElementById('new-window').addEventListener('click', () => bridge.newWindow())

// ---- remote node registry: add / save / switch ----
const remoteList = document.getElementById('remote-list')
// auto-hide scrollbar: visible while scrolling, fades 500ms after stop
let scrollHideTimer = null
remoteList.addEventListener('scroll', () => {
  remoteList.classList.add('scrolling')
  clearTimeout(scrollHideTimer)
  scrollHideTimer = setTimeout(() => remoteList.classList.remove('scrolling'), 500)
})
const remoteAddBtn = document.getElementById('remote-add')
const remoteForm = document.getElementById('remote-form')
const rfName = document.getElementById('rf-name')
const rfUrl = document.getElementById('rf-url')
const rfKey = document.getElementById('rf-key')
const rfSave = document.getElementById('rf-save')
const rfCancel = document.getElementById('rf-cancel')
const rfError = document.getElementById('rf-error')
let editingId = null

function makeBtn(text, cls, fn) {
  const button = document.createElement('button')
  button.className = `btn ${cls}`
  button.textContent = text
  button.addEventListener('click', fn)
  return button
}

async function connectRemoteById(id) {
  remoteError.textContent = ''
  try {
    const r = await bridge.remote.connect(id)
    if (r && !r.ok) remoteError.textContent = r.error || '连接失败'
  } catch (e) {
    remoteError.textContent = e || '连接失败'
  }
}

const remoteSearch = document.getElementById('remote-search')
const remoteError = document.getElementById('remote-error')
const restoreToggle = document.getElementById('restore-toggle')
const autoLocalToggle = document.getElementById('auto-local-toggle')
const healthCache = new Map() // instanceId -> { status, at } (30s TTL)

async function renderRestore() {
  const on = await bridge.settings.getRestore()
  restoreToggle.classList.toggle('on', on)
  restoreToggle.setAttribute('aria-checked', String(on))
}
restoreToggle.addEventListener('click', async () => {
  const on = !restoreToggle.classList.contains('on')
  await bridge.settings.setRestore(on)
  restoreToggle.classList.toggle('on', on)
  restoreToggle.setAttribute('aria-checked', String(on))
})

async function renderAutoLocal() {
  const on = await bridge.settings.getAutoLocal()
  autoLocalToggle.classList.toggle('on', on)
  autoLocalToggle.setAttribute('aria-checked', String(on))
}
autoLocalToggle.addEventListener('click', async () => {
  const on = !autoLocalToggle.classList.contains('on')
  await bridge.settings.setAutoLocal(on)
  autoLocalToggle.classList.toggle('on', on)
  autoLocalToggle.setAttribute('aria-checked', String(on))
})

// ---- embedded dsh self-update ----
const dshVersionEl = document.getElementById('dsh-version')
const checkUpdateBtn = document.getElementById('check-update')
const doUpdateBtn = document.getElementById('do-update')
let pendingUpdate = null // { latest } once an update is available

// Status feedback replaces the version text in the meta row (the version
// slot itself), colored by outcome; a plain version shows default tertiary ink.
function setUpdateStatus(text, kind) {
  dshVersionEl.textContent = text
  dshVersionEl.className = `version ${kind ?? ''}`
}

bridge.onUpdateLog((line) => {
  setUpdateStatus(line, null)
})

async function renderDshVersion() {
  const v = await bridge.dshVersion()
  if (!external && !v) {
    dshVersionEl.textContent = '未安装'
  } else if (external && !v) {
    dshVersionEl.textContent = '未找到全局 dsh（npm i -g @deepseek-ai/dsh）'
  } else {
    dshVersionEl.textContent = `v${v}`
  }
  dshVersionEl.className = 'version'
}

// ---- launcher self-update (GitHub Releases) ----

const launcherUpdateRow = document.getElementById('launcher-update-row')
const launcherUpdateLabel = document.getElementById('launcher-update-label')
const launcherUpdateBtn = document.getElementById('launcher-update')

async function checkLauncherUpdate() {
  try {
    const r = await bridge.checkLauncherUpdate()
    if (r && r.updateAvailable) {
      launcherUpdateLabel.textContent = `启动器 v${r.version} 可用`
      launcherUpdateRow.hidden = false
      launcherUpdateBtn.addEventListener('click', async () => {
        launcherUpdateBtn.disabled = true
        launcherUpdateBtn.textContent = '正在下载更新…'
        try {
          await bridge.launcherUpdate(r.url)
          // The app swaps its own exe and relaunches; nothing to do here.
        } catch (e) {
          launcherUpdateBtn.disabled = false
          launcherUpdateBtn.textContent = '更新失败'
          launcherUpdateLabel.textContent = e || '更新失败'
        }
      })
    }
  } catch {
    // No update channel configured / offline — stay quiet.
  }
}

checkUpdateBtn.addEventListener('click', async () => {
  checkUpdateBtn.disabled = true
  setUpdateStatus('正在检查更新…')
  try {
    const r = await bridge.checkUpdate()
    if (!r) {
      setUpdateStatus('检查失败（无法连接 npm registry）', 'err')
    } else if (r.updateAvailable) {
      pendingUpdate = r
      setUpdateStatus(`发现新版本 v${r.latest}（当前 v${r.current}）`, 'ok')
      doUpdateBtn.hidden = false
    } else {
      pendingUpdate = null
      setUpdateStatus(`已是最新版本 v${r.current}`, 'ok')
      doUpdateBtn.hidden = true
    }
  } finally {
    checkUpdateBtn.disabled = false
  }
})

doUpdateBtn.addEventListener('click', async () => {
  if (!pendingUpdate) return
  doUpdateBtn.disabled = true
  checkUpdateBtn.disabled = true
  setUpdateStatus('正在更新…', null)
  try {
    const r = await bridge.update(pendingUpdate.latest)
    if (r.ok) {
      setUpdateStatus(`已更新至 v${r.version}`, 'ok')
      doUpdateBtn.hidden = true
      pendingUpdate = null
    } else {
      setUpdateStatus(`更新失败：${r.error || '未知错误'}`, 'err')
    }
  } finally {
    doUpdateBtn.disabled = false
    checkUpdateBtn.disabled = false
  }
})

function applyHealth(dot, status) {
  dot.className = status === 'online' ? 'dot done'
    : status === 'unauthorized' ? 'dot danger'
    : 'dot'
  dot.title = status === 'online' ? '在线'
    : status === 'unauthorized' ? '密钥无效'
    : '离线'
}

async function refreshHealth(id, dot) {
  const cached = healthCache.get(id)
  if (cached && Date.now() - cached.at < 30_000) {
    applyHealth(dot, cached.status)
    return
  }
  const h = await bridge.remote.health(id)
  healthCache.set(id, { status: h.status, at: Date.now() })
  applyHealth(dot, h.status)
}

async function renderRemoteList() {
  const query = remoteSearch.value.trim().toLowerCase()
  const instances = await bridge.remote.list()
  remoteList.textContent = ''
  const matches = query
    ? instances.filter((inst) =>
        inst.name.toLowerCase().includes(query) || inst.url.toLowerCase().includes(query))
    : instances
  for (const inst of matches) {
    const row = document.createElement('div')
    row.className = 'instance-row'

    const line1 = document.createElement('div')
    line1.className = 'row-title'
    const healthDot = document.createElement('span')
    healthDot.className = 'dot'
    healthDot.title = '检测中'
    line1.appendChild(healthDot)
    const name = document.createElement('span')
    name.textContent = inst.name
    line1.appendChild(name)
    row.appendChild(line1)

    const meta = document.createElement('p')
    meta.className = 'meta'
    meta.textContent = `${inst.url} · 密钥${inst.keyConfigured ? '已配置' : '未配置'}`
    row.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(makeBtn('连接', 'primary sm', () => connectRemoteById(inst.id)))
    actions.appendChild(makeBtn('编辑', 'ghost sm', () => openRemoteForm(inst)))
    actions.appendChild(makeBtn('删除', 'ghost sm', async () => {
      await bridge.remote.remove(inst.id)
      renderRemoteList()
    }))
    row.appendChild(actions)

    remoteList.appendChild(row)
    void refreshHealth(inst.id, healthDot)
  }
  if (remoteList.children.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hint'
    empty.textContent = query ? '没有匹配的实例' : '还没有远程实例，点击上方"添加实例"'
    remoteList.appendChild(empty)
  }
}

remoteSearch.addEventListener('input', () => renderRemoteList())

function openRemoteForm(inst) {
  editingId = inst?.id ?? null
  rfName.value = inst?.name ?? ''
  rfUrl.value = inst?.url ?? ''
  rfKey.value = ''
  rfError.textContent = ''
  remoteForm.hidden = false
  rfName.focus()
}

remoteAddBtn.addEventListener('click', () => openRemoteForm(null))
rfCancel.addEventListener('click', () => { remoteForm.hidden = true })

rfSave.addEventListener('click', async () => {
  rfError.textContent = ''
  const r = await bridge.remote.save({
    id: editingId ?? undefined,
    name: rfName.value,
    url: rfUrl.value,
    key: rfKey.value,
  })
  if (r.ok) {
    remoteForm.hidden = true
    editingId = null
    renderRemoteList()
  } else {
    rfError.textContent = r.error || '保存失败'
  }
})

// settings opens the settings dialog (desktop overlay)
settingsBtn.addEventListener('click', async () => {
  try {
    await bridge.settings.open()
  } catch (e) {
    log.hidden = false
    log.textContent = e || '无法打开设置'
  }
})

// ---- custom title bar window controls (decorations: false) ----
const winMin = document.getElementById('win-min')
const winMax = document.getElementById('win-max')
const winClose = document.getElementById('win-close')
if (winMin) winMin.addEventListener('click', () => bridge.window.minimize())
if (winMax) {
  winMax.addEventListener('click', () => bridge.window.toggleMaximize())
  bridge.window.onMaximizedChanged((maximized) => {
    const restore = winMax.querySelector('.icon-restore')
    const maximize = winMax.querySelector('.icon-maximize')
    if (restore) restore.style.display = maximized ? '' : 'none'
    if (maximize) maximize.style.display = maximized ? 'none' : ''
    winMax.title = maximized ? '还原' : '最大化'
  })
}
if (winClose) winClose.addEventListener('click', () => bridge.window.close())

// ---- events ----
bridge.onExited(() => {
  setState('idle')
})
bridge.onBacked(() => {
  titleStatus.textContent = 'DeepSeek Harness'
})
bridge.onConnectionChanged((detail) => {
  titleStatus.textContent = detail.name || 'DeepSeek Harness'
})

// ---- platform adaptation ----
bridge.appInfo().then((info) => {
  document.body.classList.add(info.desktop ? 'desktop' : 'mobile')
  // macOS: the window keeps native traffic lights (Overlay titlebar) — the
  // CSS pads the strip and hides the custom window buttons.
  if (info.platform === 'macos') document.body.classList.add('macos')
  if (!info.desktop) {
    // Mobile: no embedded local instance, no settings dialog, no title bar.
    document.getElementById('local-section')?.remove()
    document.getElementById('titlebar')?.remove()
    // WebView < 140 reports wrong env(safe-area-inset-*) under edge-to-edge;
    // read the real inset natively.
    bridge.statusBarHeight().then((height) => {
      if (height && height > 0) {
        document.documentElement.style.setProperty('--safe-area-inset-top', `${height}px`)
      }
    }).catch(() => {})
  } else if (!info.bundled) {
    // External flavor: the dsh runtime is the user's own npm install — the
    // in-app dsh updater would mutate something the user owns, so hide it.
    external = true
    document.getElementById('check-update')?.remove()
    document.getElementById('do-update')?.remove()
  }
}).catch(() => {})

refresh()
renderRemoteList()
renderRestore()
renderAutoLocal()
renderDshVersion()
checkLauncherUpdate()
// The window starts hidden to avoid a white flash; reveal it once painted.
bridge.shellReady().catch(() => {})
// Poll local status so the badge tracks boot/exit transitions live while the
// launcher is on screen (e.g. restore boot, or stop from another window).
setInterval(refresh, 1500)

// inactive-window dimming (mainstream title-bar behavior)
const syncActive = () => document.body.classList.toggle('inactive', !document.hasFocus())
window.addEventListener('focus', syncActive)
window.addEventListener('blur', syncActive)
syncActive()

// F12 opens DevTools (debug builds), like the Electron app — never auto-open.
window.addEventListener('keydown', (event) => {
  if (event.key === 'F12') {
    bridge.openDevTools().catch(() => {})
  }
})
