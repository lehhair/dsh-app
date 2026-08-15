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
