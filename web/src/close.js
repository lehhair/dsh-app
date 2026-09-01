// Close-confirm dialog page logic. Runs inside the transparent close child
// webview (desktop), shown by Rust when a close request is intercepted with
// behavior = ask. Two actions: confirm close, or hide to the system tray.
// The 记住此操作 switch persists the choice into closeBehavior so future
// closes skip this dialog entirely (managed + reset from 启动页 → 更多).

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

const rememberToggle = document.getElementById('remember-toggle')
const toTrayBtn = document.getElementById('to-tray')
const confirmBtn = document.getElementById('confirm')
const closeBtn = document.getElementById('close')
const mask = document.getElementById('mask')

const remembered = () => rememberToggle.classList.contains('on')

// JS-driven hover: the overlay is a child webview that hides without a
// mouseleave, so a pseudo-class :hover would stick (same fix as settings.js).
document.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('mouseenter', () => btn.classList.add('hover'))
  btn.addEventListener('mouseleave', () => btn.classList.remove('hover'))
})

function dismiss() {
  bridge.windowCloseCancel().catch(() => {})
}

rememberToggle.addEventListener('click', () => {
  const on = !remembered()
  rememberToggle.classList.toggle('on', on)
  rememberToggle.setAttribute('aria-checked', String(on))
})

toTrayBtn.addEventListener('click', async () => {
  if (remembered()) {
    await bridge.settings.setCloseBehavior('tray').catch(() => {})
  }
  await bridge.windowCloseToTray().catch(() => {})
})

confirmBtn.addEventListener('click', async () => {
  if (remembered()) {
    await bridge.settings.setCloseBehavior('close').catch(() => {})
  }
  await bridge.windowCloseConfirm().catch(() => {})
})

closeBtn.addEventListener('click', dismiss)
mask.addEventListener('click', dismiss)
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismiss()
})