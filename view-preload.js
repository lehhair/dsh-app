// Theme sampler for the dsh WebContentsView: reads the tokens the dsh page
// ACTUALLY renders with (aliases resolve through whatever theme the page or
// a theme extension applied) and ships them to the shell UI so the custom
// title bar stays visually fused with the page. This preload exposes nothing
// to the page — no contextBridge call — so remote content cannot touch it.
//
// Covers: initial load, data-ds-dark-theme flips, :root/body style rewrites,
// and injected <style> token overrides (polled, since those don't mutate
// attributes).
const { ipcRenderer } = require('electron')

const TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-border-l2',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
]

function sampleTokens() {
  const style = window.getComputedStyle(document.body)
  const out = {}
  for (const name of TOKENS) {
    const value = style.getPropertyValue(name).trim()
    if (value) out[name] = value
  }
  return out
}

function init() {
  const publish = () => ipcRenderer.send('theme:changed', sampleTokens())
  const observer = new MutationObserver(publish)
  for (const target of [document.documentElement, document.body]) {
    observer.observe(target, { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] })
  }
  // Injected <style> sheets (theme extensions) rewrite tokens without
  // attribute mutations; a cheap poll is the reliable backstop.
  setInterval(publish, 2000)
  publish()
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}





// ---- injection spike (route A, minimal) ----
// Injects a single "回到启动页" button into dsh's own settings panel header
// (the actions seat, next to dsh's own buttons). No nav section, no content
// takeover — just one button that routes back to the launcher. Enabled via
// DSH_INJECT_SETTINGS=1 (desktop verification); the mechanism is
// container-agnostic (dialog located by stable ARIA, button seat by the
// stable data-slot marker), so it ports to mobile WebView unchanged.
//
// The button visuals copy dsh's outline capsule (sm: h28 r14, border-l2,
// label-primary ink, interactive-bg-hover on hover) — dsw tokens only.

const BACK_KEY = 'dsh-app-back-to-launcher'

const BACK_STYLE_ID = 'dsh-app-back-style'
const BACK_STYLES = `
  .${BACK_KEY} {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: 14px;
    background: transparent;
    color: var(--dsw-alias-label-primary);
    font: inherit;
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;
  }
  .${BACK_KEY}:hover { background: var(--dsw-alias-interactive-bg-hover); }
`

let backButton = null

function ensureBackButton() {
  if (backButton && backButton.isConnected) return
  injectBackStyles()
  // The actions seat is the stable data-slot marker dsh renders in the panel
  // header (its own "打开配置文件" action lives there too).
  const seat = document.querySelector('[data-slot="settings.action"]')
  const host = seat?.parentElement
  if (!seat || !host) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = BACK_KEY
  btn.textContent = '回到启动页'
  btn.addEventListener('click', () => {
    ipcRenderer.invoke('shell:back')
  })
  host.appendChild(btn)
  backButton = btn
}

function injectBackStyles() {
  if (document.getElementById(BACK_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = BACK_STYLE_ID
  style.textContent = BACK_STYLES
  document.head.appendChild(style)
}

function watchSettingsPanel() {
  // The settings panel is the app's aria-modal dialog (stable ARIA). When it
  // is open, make sure our button is in the header; when it closes, drop the
  // reference (the panel unmounts, so the button goes with it).
  const findPanel = () => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      ensureBackButton()
    } else {
      backButton = null
    }
  }
  findPanel()
  setInterval(findPanel, 1000)
}

// The flag arrives via argv (additionalArguments) — sandboxed preloads have no
// process.env.
if (process.argv.includes('--dsh-inject-settings')) {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', watchSettingsPanel, { once: true })
  } else {
    watchSettingsPanel()
  }
}
