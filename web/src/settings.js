// Settings overlay page logic — the direct port of the Electron settings
// dialog script, wired to the `bridge` wrapper. Runs as an app page inside
// the transparent settings child webview (desktop).

import { bridge } from './bridge.js'

// ---- dsh alias token -> shell variable map (theme fusion, same as launcher) ----
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
  '--dsw-alias-button-primary-fill': '--shell-brand',
  '--dsw-alias-button-primary-hover': '--shell-brand-hover',
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

const closeBtn = document.getElementById('close')
const curName = document.getElementById('cur-name')
const curUrl = document.getElementById('cur-url')
const disconnectBtn = document.getElementById('disconnect')
const toLauncherBtn = document.getElementById('to-launcher')
const instancesEl = document.getElementById('instances')
const dlgError = document.getElementById('dlg-error')

// ---- local embedded instance row ----
const localDot = document.getElementById('local-dot')
const localUrl = document.getElementById('local-url')
const localToggle = document.getElementById('local-toggle')
const localEnter = document.getElementById('local-enter')

async function renderLocal() {
  const s = await bridge.status()
  if (s.starting) {
    localDot.className = 'dot chase'
    localDot.textContent = ''
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 10 10')
    svg.setAttribute('shape-rendering', 'crispEdges')
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
    localDot.appendChild(svg)
    localUrl.textContent = '正在启动…'
    localToggle.textContent = '启动中'
    localToggle.className = 'btn primary'
    localToggle.disabled = true
    localEnter.disabled = true
    return
  }
  localDot.className = s.running ? 'dot done' : 'dot'
  localDot.textContent = ''
  localUrl.textContent = s.running ? s.url : '未启动'
  localToggle.textContent = s.running ? '停止' : '启动'
  localToggle.className = `btn ${s.running ? 'outline' : 'primary'}`
  localToggle.disabled = false
  localEnter.disabled = !s.running
}

localToggle.addEventListener('click', async () => {
  const s = await bridge.status()
  if (s.running) await bridge.stopLocal()
  else await bridge.startLocal()
  renderLocal()
})

localEnter.addEventListener('click', async () => {
  const s = await bridge.status()
  if (s.running) {
    await bridge.connect(s.url)
    await bridge.settings.close()
  }
})

closeBtn.addEventListener('click', () => bridge.settings.close())

let currentId = null
async function renderCurrent() {
  const cur = await bridge.settings.current()
  currentId = cur.id ?? null
  if (cur.type === null) {
    curName.textContent = '未连接'
    curUrl.textContent = ''
    disconnectBtn.disabled = true
    return
  }
  curName.textContent = cur.type === 'local' ? '本机实例' : cur.name
  curUrl.textContent = cur.url
  disconnectBtn.disabled = false
}

let instanceQuery = ''
const instSearch = document.getElementById('inst-search')
const scrollZone = document.querySelector('.dialog-scroll')
// auto-hide scrollbar: visible while scrolling, fades after stop
let scrollHideTimer = null
scrollZone.addEventListener('scroll', () => {
  scrollZone.classList.add('scrolling')
  clearTimeout(scrollHideTimer)
  scrollHideTimer = setTimeout(() => scrollZone.classList.remove('scrolling'), 500)
})

async function renderInstances() {
  const query = instanceQuery
  const instances = await bridge.remote.list()
  const matches = query
    ? instances.filter((inst) =>
        inst.name.toLowerCase().includes(query) || inst.url.toLowerCase().includes(query))
    : instances
  instancesEl.textContent = ''
  for (const inst of matches) {
    const row = document.createElement('div')
    row.className = 'instance-row'
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.title = '检测中'
    row.appendChild(dot)
    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = inst.name
    if (currentId === inst.id) {
      const pill = document.createElement('span')
      pill.className = 'pill on'
      pill.textContent = '当前'
      name.appendChild(pill)
    }
    const url = document.createElement('div')
    url.className = 'url'
    url.textContent = inst.url
    meta.append(name, url)
    const connect = document.createElement('button')
    connect.className = 'btn primary'
    connect.textContent = '连接'
    connect.addEventListener('click', async () => {
      dlgError.textContent = ''
      try {
        const r = await bridge.remote.connect(inst.id)
        if (r && r.ok) await bridge.settings.close()
        else dlgError.textContent = (r && r.error) || '连接失败'
      } catch (e) {
        dlgError.textContent = e || '连接失败'
      }
    })
    row.append(dot, meta, connect)
    instancesEl.appendChild(row)
    bridge.remote.health(inst.id).then((h) => {
      dot.className = h.status === 'online' ? 'dot done'
        : h.status === 'unauthorized' ? 'dot danger'
        : 'dot'
      dot.title = h.status === 'online' ? '在线'
        : h.status === 'unauthorized' ? '密钥无效'
        : '离线'
    })
  }
  if (matches.length === 0) {
    const hint = document.createElement('p')
    hint.className = 'hint'
    hint.textContent = query ? '没有匹配的实例' : '还没有远程实例，可在启动页添加。'
    instancesEl.appendChild(hint)
  }
}

instSearch.addEventListener('input', (event) => {
  instanceQuery = event.target.value.trim().toLowerCase()
  renderInstances()
})

disconnectBtn.addEventListener('click', async () => {
  await bridge.remote.disconnect()
  await bridge.settings.close()
})

toLauncherBtn.addEventListener('click', async () => {
  await bridge.back()
  await bridge.settings.close()
})

renderCurrent()
renderLocal()
renderInstances()
