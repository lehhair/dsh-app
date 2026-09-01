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

let lastStatus = null // previous poll, for transition detection

async function refresh() {
  const s = await bridge.status()
  const status = s.starting ? 'starting' : s.running ? 'running' : 'idle'
  setState(status, s.port, s.url)
  // The log ring is up to 5000 lines joined in Rust — refetching it every
  // poll tick wastes IPC for nothing. Pull it while boot output is
  // streaming in, and once on each state transition (final output).
  if (status !== 'idle' && (status === 'starting' || status !== lastStatus)) {
    const logs = await bridge.logs()
    log.hidden = false
    log.textContent = logs.join('\n').slice(-4000)
    log.scrollTop = log.scrollHeight
  }
  lastStatus = status
}

startBtn.addEventListener('click', async () => {
  setState('starting')
  // Bundled installs ship node + npm only — install the dsh runtime first
  // when it is missing, then boot.
  if (!external && !runtimeInstalled) {
    log.hidden = false
    log.textContent = '正在安装 dsh 运行时…'
    setUpdateInProgress(true)
    const r = await bridge.install().catch((e) => ({ ok: false, error: e || '安装失败' }))
    setUpdateInProgress(false)
    renderDshVersion()
    if (!r.ok) {
      setState('error')
      log.textContent = `安装 dsh 失败：${r.error || '未知错误'}\n${(await bridge.logs().catch(() => [])).join('\n').slice(-4000)}`
      return
    }
  }
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
  showConnecting('本机实例')
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
let openInlineForm = null // the currently expanded row edit form (if any)

function makeBtn(text, cls, fn) {
  const button = document.createElement('button')
  button.className = `btn ${cls}`
  button.textContent = text
  button.addEventListener('click', fn)
  return button
}

async function connectRemoteById(id, name) {
  remoteError.textContent = ''
  showConnecting(name)
  try {
    const r = await bridge.remote.connect(id)
    if (r && !r.ok) {
      hideConnecting()
      remoteError.textContent = r.error || '连接失败'
    }
  } catch (e) {
    hideConnecting()
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

// ---- close-button behavior (更多 → 关闭行为) ----
// "ask" (每次询问, default) | "close" (直接关闭) | "tray" (退到托盘).
// The confirm dialog can also set this via 记住此操作; 重置 restores "ask".
const closeBehaviorLabel = document.getElementById('close-behavior-label')
const closeBehaviorPanel = document.getElementById('close-behavior-panel')
const closeBehaviorSave = document.getElementById('close-behavior-save')
const closeBehaviorCancel = document.getElementById('close-behavior-cancel')

const CLOSE_BEHAVIOR_TEXT = {
  ask: '每次询问',
  close: '直接关闭',
  tray: '退到托盘',
}

function ringCloseOption(behavior) {
  closeBehaviorPanel.querySelectorAll('[data-close-behavior]').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.closeBehavior === behavior)
  })
}

async function renderCloseBehavior() {
  const behavior = await bridge.settings.getCloseBehavior().catch(() => 'ask')
  closeBehaviorLabel.textContent = CLOSE_BEHAVIOR_TEXT[behavior] ?? CLOSE_BEHAVIOR_TEXT.ask
  ringCloseOption(behavior)
}

document.getElementById('close-behavior-edit').addEventListener('click', () => {
  closeBehaviorPanel.hidden = !closeBehaviorPanel.hidden
})
closeBehaviorCancel.addEventListener('click', () => {
  closeBehaviorPanel.hidden = true
})
closeBehaviorPanel.querySelectorAll('[data-close-behavior]').forEach((btn) => {
  btn.addEventListener('click', () => ringCloseOption(btn.dataset.closeBehavior))
})
closeBehaviorSave.addEventListener('click', async () => {
  const selected = closeBehaviorPanel.querySelector('.close-option.selected')
  const behavior = selected ? selected.dataset.closeBehavior : 'ask'
  try {
    await bridge.settings.setCloseBehavior(behavior)
    closeBehaviorPanel.hidden = true
    renderCloseBehavior()
  } catch (e) {
    closeBehaviorLabel.textContent = e || '保存失败'
  }
})
document.getElementById('close-behavior-reset').addEventListener('click', async () => {
  try {
    await bridge.settings.resetCloseBehavior()
  } catch (_e) {}
  closeBehaviorPanel.hidden = true
  renderCloseBehavior()
})

// ---- collapsible 更多 (版本与源) ----
// Low-frequency settings live behind a fold; the toggle row shows a
// version · registry summary so the state stays visible while collapsed.
// An available update auto-expands the fold once and tints the summary.
const moreToggle = document.getElementById('more-toggle')
const moreGroup = document.getElementById('more-group')
const moreSummary = document.getElementById('more-summary')
let summaryVersion = ''
let summaryRegistry = ''
let moreAttentionText = null // e.g. 发现新版本 v… — replaces the summary

function renderMoreSummary() {
  if (moreAttentionText) {
    moreSummary.textContent = moreAttentionText
    moreSummary.classList.add('attention')
  } else {
    moreSummary.textContent = [summaryVersion, summaryRegistry].filter(Boolean).join(' · ')
    moreSummary.classList.remove('attention')
  }
}

function setMoreOpen(open, persist = true) {
  moreGroup.hidden = !open
  moreToggle.setAttribute('aria-expanded', String(open))
  if (persist) {
    try { localStorage.setItem('dsh-more-open', open ? '1' : '0') } catch (_e) {}
  }
}
moreToggle.addEventListener('click', () => setMoreOpen(moreGroup.hidden))
try {
  if (localStorage.getItem('dsh-more-open') === '1') setMoreOpen(true, false)
} catch (_e) {}

function flagUpdateAvailable(text) {
  moreAttentionText = text
  setMoreOpen(true, false) // surface the update; don't overwrite the user's fold preference
  renderMoreSummary()
}

// ---- embedded dsh self-update ----
const dshVersionEl = document.getElementById('dsh-version')
const checkUpdateBtn = document.getElementById('check-update')
const doUpdateBtn = document.getElementById('do-update')
const updateRow = document.getElementById('dsh-update-row')
const updateText = document.getElementById('dsh-update-text')
let pendingUpdate = null // { latest } once an update is available

// The version row shows only the installed version; check/install/update
// feedback lives in its own status row below it, colored by outcome.
function setUpdateStatus(text, kind) {
  updateRow.hidden = !text
  if (!text) return
  updateText.textContent = text
  updateText.className = `update-text ${kind ?? ''}`
}

bridge.onUpdateLog((line) => {
  setUpdateStatus(line, null)
})

let runtimeInstalled = false // a managed (bundled) runtime is present — the
// bundled installer ships node+npm only, so dsh is installed on demand here.

async function renderDshVersion() {
  const v = await bridge.dshVersion()
  runtimeInstalled = !!v
  if (!external && !v) {
    dshVersionEl.textContent = '未安装'
    checkUpdateBtn.textContent = '安装 dsh'
    summaryVersion = '未安装'
  } else if (external && !v) {
    dshVersionEl.textContent = '未找到全局 dsh（npm i -g @deepseek-ai/dsh）'
    summaryVersion = '未安装'
    // Surface the resolution chain so a failing probe is visible instead of
    // a bare hint — put it in the boot log area for easy copy-paste.
    const diag = await bridge.diagnose().catch(() => null)
    if (diag) {
      log.hidden = false
      log.textContent = `[诊断] 未找到全局 dsh，解析链：\n${diag}`
    }
  } else {
    dshVersionEl.textContent = `v${v}`
    checkUpdateBtn.textContent = '检查更新'
    summaryVersion = `v${v}`
  }
  renderMoreSummary()
}

// ---- launcher self-update (GitHub Releases) ----

const launcherUpdateRow = document.getElementById('launcher-update-row')
const launcherUpdateLabel = document.getElementById('launcher-update-label')
const launcherUpdateBtn = document.getElementById('launcher-update')

async function checkLauncherUpdate() {
  try {
    const r = await bridge.checkLauncherUpdate()
    if (r && r.updateAvailable) {
      launcherUpdateLabel.textContent = `v${r.version} 可用`
      launcherUpdateRow.hidden = false
      flagUpdateAvailable(`启动器 v${r.version} 可用`)
      launcherUpdateBtn.addEventListener('click', async () => {
        launcherUpdateBtn.disabled = true
        launcherUpdateBtn.textContent = '正在下载更新…'
        try {
          await bridge.launcherUpdate(r.url, r.sha256 ?? null)
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

const cancelUpdateBtn = document.getElementById('cancel-update')
let updateInProgress = false

// While an update/install runs, offer a cancel button; clear it afterwards.
function setUpdateInProgress(inProgress) {
  updateInProgress = inProgress
  cancelUpdateBtn.hidden = !inProgress
}

cancelUpdateBtn.addEventListener('click', async () => {
  cancelUpdateBtn.disabled = true
  try {
    await bridge.cancelUpdate()
    setUpdateStatus('正在取消…', null)
  } finally {
    cancelUpdateBtn.disabled = false
  }
})

checkUpdateBtn.addEventListener('click', async () => {
  checkUpdateBtn.disabled = true
  // Bundled flavor with no runtime yet: this button installs dsh instead.
  if (!external && !runtimeInstalled) {
    setUpdateStatus('正在安装 dsh…', null)
    setUpdateInProgress(true)
    try {
      const r = await bridge.install()
      if (r.ok) {
        setUpdateStatus(`安装完成：v${r.version}`, 'ok')
      } else {
        setUpdateStatus(`安装失败：${r.error || '未知错误'}`, 'err')
      }
    } finally {
      setUpdateInProgress(false)
      checkUpdateBtn.disabled = false
      renderDshVersion() // refresh label + state after the install
    }
    return
  }
  setUpdateStatus('正在检查更新…', null)
  doUpdateBtn.hidden = true
  try {
    const r = await bridge.checkUpdate()
    if (!r) {
      setUpdateStatus('检查失败（无法连接 npm registry）', 'err')
    } else if (r.updateAvailable) {
      pendingUpdate = r
      setUpdateStatus(`发现新版本 v${r.latest}（当前 v${r.current}）`, 'ok')
      doUpdateBtn.textContent = `更新到 v${r.latest}`
      doUpdateBtn.hidden = false
      flagUpdateAvailable(`发现新版本 v${r.latest}`)
    } else {
      pendingUpdate = null
      setUpdateStatus(`已是最新版本 v${r.current}`, 'ok')
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
  setUpdateInProgress(true)
  try {
    const r = await bridge.update(pendingUpdate.latest)
    if (r.ok) {
      setUpdateStatus(`已更新至 v${r.version}`, 'ok')
      doUpdateBtn.hidden = true
      pendingUpdate = null
      moreAttentionText = null
      renderDshVersion() // the version row must follow the new install
    } else if (r.error === '已取消') {
      setUpdateStatus('已取消更新', 'err')
    } else {
      setUpdateStatus(`更新失败：${r.error || '未知错误'}`, 'err')
    }
  } finally {
    setUpdateInProgress(false)
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
    actions.appendChild(makeBtn('连接', 'primary sm', () => connectRemoteById(inst.id, inst.name)))
    const edit = buildInlineEditForm(inst.id, () => renderRemoteList())
    actions.appendChild(makeBtn('编辑', 'ghost sm', () => openRowEdit(edit, inst)))
    actions.appendChild(makeBtn('删除', 'ghost sm', async () => {
      await bridge.remote.remove(inst.id)
      renderRemoteList()
    }))
    row.appendChild(actions)
    row.appendChild(edit.form)

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

// ---- inline instance form: ONE builder for both adding (fixed above the
// list) and editing (inline per row) — a single DOM shape, so the two can
// never drift apart in spacing or style. ----

function buildInstanceForm({ onSave, onCancel }) {
  const form = document.createElement('div')
  form.className = 'remote-form'
  form.hidden = true
  const name = document.createElement('input')
  name.className = 'field'
  name.placeholder = '名称，如 书房网关'
  name.spellcheck = false
  const url = document.createElement('input')
  url.className = 'field'
  url.placeholder = 'http://192.168.1.233:8443'
  url.spellcheck = false
  const key = document.createElement('input')
  key.className = 'field'
  key.type = 'password'
  key.placeholder = '访问密钥（留空保留）'
  const fieldRow = document.createElement('div')
  fieldRow.className = 'field-row'
  fieldRow.append(name, url, key)
  const error = document.createElement('p')
  error.className = 'error'
  error.style.minHeight = '0'
  error.style.margin = '8px 0 0'
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.style.marginTop = '10px'
  actions.append(
    makeBtn('保存', 'primary sm', () => onSave({ name, url, key, error })),
    makeBtn('取消', 'ghost sm', onCancel),
  )
  form.append(fieldRow, actions, error)
  return { form, name, url, key, error }
}

// The add-instance form: identical to the row edit form, fixed above the list.
const addForm = buildInstanceForm({
  onSave: async ({ name, url, key, error }) => {
    error.textContent = ''
    const r = await bridge.remote.save({ name: name.value, url: url.value, key: key.value })
    if (r.ok) {
      addForm.form.hidden = true
      name.value = ''
      url.value = ''
      key.value = ''
      renderRemoteList()
    } else {
      error.textContent = r.error || '保存失败'
    }
  },
  onCancel: () => { addForm.form.hidden = true },
})
remoteList.before(addForm.form)

remoteAddBtn.addEventListener('click', () => {
  if (openInlineForm) {
    openInlineForm.hidden = true
    openInlineForm = null
  }
  addForm.name.value = ''
  addForm.url.value = ''
  addForm.key.value = ''
  addForm.error.textContent = ''
  addForm.form.hidden = false
  addForm.name.focus()
})

function buildInlineEditForm(id, onSaved) {
  const f = buildInstanceForm({
    onSave: async ({ name, url, key, error }) => {
      error.textContent = ''
      const r = await bridge.remote.save({ id, name: name.value, url: url.value, key: key.value })
      if (r.ok) {
        f.form.hidden = true
        if (openInlineForm === f.form) openInlineForm = null
        onSaved()
      } else {
        error.textContent = r.error || '保存失败'
      }
    },
    onCancel: () => {
      f.form.hidden = true
      if (openInlineForm === f.form) openInlineForm = null
    },
  })
  return f
}

function openRowEdit(edit, inst) {
  addForm.form.hidden = true // close the add form
  if (openInlineForm && openInlineForm !== edit.form) openInlineForm.hidden = true
  edit.name.value = inst.name
  edit.url.value = inst.url
  edit.key.value = ''
  edit.form.hidden = false
  openInlineForm = edit.form
  edit.name.focus()
}

// ---- JS-driven hover for buttons that can end up COVERED ----
// A pseudo-class :hover sticks forever once another webview (settings
// overlay, node view) covers this page: Chromium only re-evaluates it on
// real mouse moves, which the covering webview swallows. Button highlight
// is therefore maintained as a .hover class via mouseover/mouseout
// delegation, and cleared explicitly when a click is about to cover the
// page (settings button) or when we come back to the launcher (onBacked).
document.addEventListener('mouseover', (event) => {
  const btn = event.target.closest('.btn, .win-btn.settings')
  if (btn) btn.classList.add('hover')
})
document.addEventListener('mouseout', (event) => {
  const btn = event.target.closest('.btn, .win-btn.settings')
  if (btn && !btn.contains(event.relatedTarget)) btn.classList.remove('hover')
})

// settings opens the settings dialog (desktop overlay)
settingsBtn.addEventListener('click', async () => {
  settingsBtn.classList.remove('hover') // the overlay covers the button — clear now
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
    document.body.classList.toggle('maximized', maximized)
    const restore = winMax.querySelector('.icon-restore')
    const maximize = winMax.querySelector('.icon-maximize')
    if (restore) restore.style.display = maximized ? '' : 'none'
    if (maximize) maximize.style.display = maximized ? 'none' : ''
    winMax.title = maximized ? '还原' : '最大化'
  })
}
if (winClose) winClose.addEventListener('click', () => bridge.window.close())

// ---- connecting overlay（恢复连接/手动连接时的加载动画）----
// The Rust side keeps the node view hidden until its first page load
// lands; this overlay is what covers the wait instead of a white flash.
const connectingOverlay = document.getElementById('connecting-overlay')
const connectingText = document.getElementById('connecting-text')
function showConnecting(name) {
  // Mobile has no layered views — connecting navigates the whole page
  // away, so the overlay would just flash for a frame. Skip it there.
  if (document.body.classList.contains('mobile')) return
  connectingText.textContent = name ? `正在连接 ${name}…` : '正在连接…'
  connectingOverlay.hidden = false
}
function hideConnecting() {
  connectingOverlay.hidden = true
}
bridge.onConnecting((name) => showConnecting(name))
bridge.onConnectFailed(() => hideConnecting())
// Restore may begin before this page's listeners attach — query once.
bridge.shellConnecting().then((name) => { if (name) showConnecting(name) }).catch(() => {})

// ---- events ----
bridge.onExited(() => {
  setState('idle')
})
bridge.onBacked(() => {
  titleStatus.textContent = 'DeepSeek Harness'
  // Node views covered the launcher — any button highlighted at connect
  // time never saw a mouseleave. Clear every JS hover on the way back.
  document.querySelectorAll('.hover').forEach((el) => el.classList.remove('hover'))
})
bridge.onConnectionChanged((detail) => {
  titleStatus.textContent = detail.name || 'DeepSeek Harness'
  hideConnecting()
})

// ---- npm registry (源) ----
const registryLabel = document.getElementById('registry-label')
const registryForm = document.getElementById('registry-form')
const registryCustom = document.getElementById('registry-custom')
const registryError = document.getElementById('registry-error')

const REGISTRY_PRESETS = [
  { url: 'https://registry.npmjs.org/', name: 'npm 官方源' },
  { url: 'https://registry.npmmirror.com', name: 'npmmirror 国内镜像' },
]
const normRegistry = (url) => (url || '').trim().replace(/\/+$/, '')
const registryHost = (url) => {
  try {
    return new URL(url).host
  } catch (_e) {
    return url
  }
}

async function renderRegistry() {
  const r = await bridge.registry.get().catch(() => null)
  if (!r) {
    registryLabel.textContent = '读取失败'
    registryLabel.title = ''
    return
  }
  const current = normRegistry(r.registry)
  const preset = REGISTRY_PRESETS.find((p) => normRegistry(p.url) === current)
  registryLabel.textContent = preset ? preset.name : registryHost(r.registry)
  registryLabel.title = r.registry
  summaryRegistry = registryLabel.textContent
  renderMoreSummary()
  // Ring the option matching the effective registry (custom URLs ring none).
  registryForm.querySelectorAll('[data-registry]').forEach((btn) => {
    btn.classList.toggle('selected', normRegistry(btn.dataset.registry) === current)
  })
}

async function saveRegistry(url) {
  registryError.hidden = true
  try {
    await bridge.registry.set(url)
    registryForm.hidden = true
    renderRegistry()
  } catch (e) {
    registryError.textContent = e || '保存失败'
    registryError.hidden = false
  }
}

document.getElementById('registry-edit').addEventListener('click', () => {
  registryError.hidden = true
  registryCustom.value = ''
  registryForm.hidden = !registryForm.hidden
})
document.getElementById('registry-cancel').addEventListener('click', () => {
  registryForm.hidden = true
})
registryForm.querySelectorAll('[data-registry]').forEach((btn) => {
  btn.addEventListener('click', () => saveRegistry(btn.dataset.registry))
})
document.getElementById('registry-save').addEventListener('click', () => {
  const url = registryCustom.value.trim()
  if (!url) {
    registryError.textContent = '请输入源地址'
    registryError.hidden = false
    return
  }
  saveRegistry(url)
})

// ---- platform adaptation ----
bridge.appInfo().then((info) => {
  const appVersion = document.getElementById('app-version')
  if (appVersion) appVersion.textContent = `启动器 v${info.version}`
  document.body.classList.add(info.desktop ? 'desktop' : 'mobile')
  // macOS: the window keeps native traffic lights (Overlay titlebar) — the
  // CSS pads the strip and hides the custom window buttons.
  if (info.platform === 'macos') document.body.classList.add('macos')
  if (!info.desktop) {
    // Mobile: no embedded local instance, no settings dialog, no title bar.
    document.getElementById('local-section')?.remove()
    document.getElementById('titlebar')?.remove()
    // WebView < 140 reports wrong env(safe-area-inset-*) under edge-to-edge;
    // read the real inset natively. The page stays hidden (html.pad-pending)
    // until the inset is applied — a cached value from a previous launch was
    // already set synchronously in the inline head script, so this is only a
    // jump-free refresh.
    bridge.statusBarHeight().then((height) => {
      if (height && height > 0) {
        document.documentElement.style.setProperty('--safe-area-inset-top', `${height}px`)
        try { localStorage.setItem('dsh-safe-area-top', String(height)) } catch (_e) {}
      }
    }).catch(() => {}).finally(() => {
      document.documentElement.classList.remove('pad-pending')
    })
  } else {
    // Desktop has no safe-area inset — reveal immediately.
    document.documentElement.classList.remove('pad-pending')
    if (!info.bundled) {
      // External flavor: the dsh runtime is the user's own npm install. The
      // in-app updater mutates the user's global dsh (npm i -g) rather than a
      // launcher-owned runtime — keep the buttons, they update the global
      // install the user asked us to manage.
      external = true
      // "内嵌" is the bundled flavor's story; the external launcher boots
      // the user's own global dsh.
      startBtn.textContent = '启动 dsh'
    }
  }
}).catch(() => {
  document.documentElement.classList.remove('pad-pending')
})

refresh()
renderRemoteList()
renderRestore()
renderAutoLocal()
renderCloseBehavior()
renderDshVersion()
renderRegistry()
checkLauncherUpdate()
// The window starts hidden to avoid a white flash; reveal it once painted.
bridge.shellReady().catch(() => {})
// Poll local status so the badge tracks boot/exit transitions live while the
// launcher is on screen (e.g. restore boot, or stop from another window).
setInterval(refresh, 1500)

// inactive-window dimming (mainstream title-bar behavior). Keyed on OS
// WINDOW focus, NOT document focus: with the multi-webview shell the
// launcher's document loses focus whenever the user clicks the dsh content
// view (a separate webview), which would dim the titlebar mid-work while the
// window is plainly active. Window-level events (tauri://focus/blur) fire
// only on real activation changes; isFocused() seeds the initial state.
const setInactive = (focused) => {
  if (typeof focused === 'boolean') {
    document.body.classList.toggle('inactive', !focused)
  }
}
bridge.window.isFocused().then(setInactive).catch(() => {})
bridge.window.onFocusChanged(setInactive).catch(() => {})

// F12 opens DevTools (debug builds), like the Electron app — never auto-open.
window.addEventListener('keydown', (event) => {
  if (event.key === 'F12') {
    bridge.openDevTools().catch(() => {})
  }
})
